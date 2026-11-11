/**
 * Systemstatus fuer Administratoren (Phase 16a, Task 8): Datenbank, Scheduler-Laeufe,
 * Belegarchiv (freier Platz, nicht archivierte Belege), letzte Kettenpruefung, letzte Sicherung.
 */
import { promises as fs } from "node:fs";
import { dbInternal } from "@/lib/db";
import { checkDb } from "@/lib/health";
import { archiveRoot } from "@/lib/archive/storage";
import { JOB_ORDER } from "@/domain/scheduler/runner";

export interface SystemHealth {
  db: boolean;
  scheduler: Record<string, string | null>;
  archive: { freeBytes: number | null; pending: number };
  chain: { lastCheckedAt: string; valid: boolean } | null;
  backup: { lastOkAt: string } | null;
}

async function freeBytes(): Promise<number | null> {
  try {
    const s = await fs.statfs(archiveRoot());
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Liest die letzte Zeile `OK <ISO>` aus der Statusdatei der Sicherung (`BACKUP_STATUS_FILE`). */
export async function readBackupStatus(file: string | undefined = process.env.BACKUP_STATUS_FILE): Promise<{ lastOkAt: string } | null> {
  if (!file) return null;
  try {
    const lines = (await fs.readFile(file, "utf8")).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^OK (\d{4}-\d{2}-\d{2}T\S+)\s*$/.exec(lines[i] ?? "");
      if (m?.[1] && !Number.isNaN(Date.parse(m[1]))) return { lastOkAt: m[1] };
    }
  } catch {
    /* Datei fehlt/unlesbar -> keine Angabe */
  }
  return null;
}

export async function getSystemHealth(orgId: string): Promise<SystemHealth> {
  const db = await checkDb();
  const scheduler: Record<string, string | null> = {};
  for (const job of JOB_ORDER) {
    const last = await dbInternal.schedulerRun.findFirst({
      where: { job, status: "OK" },
      orderBy: { startedAt: "desc" },
      select: { finishedAt: true, startedAt: true },
    });
    scheduler[job] = last ? (last.finishedAt ?? last.startedAt).toISOString() : null;
  }
  const [invoicesPending, dunningsPending, chain] = await Promise.all([
    dbInternal.invoice.count({ where: { orgId, status: { not: "DRAFT" }, number: { not: null }, archivedDocuments: { none: {} } } }),
    dbInternal.dunning.count({ where: { pdfPath: null, invoice: { orgId } } }),
    dbInternal.chainVerification.findFirst({ where: { orgId }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true, valid: true } }),
  ]);
  return {
    db,
    scheduler,
    archive: { freeBytes: await freeBytes(), pending: invoicesPending + dunningsPending },
    chain: chain ? { lastCheckedAt: chain.checkedAt.toISOString(), valid: chain.valid } : null,
    backup: await readBackupStatus(),
  };
}
