/**
 * Systemstatus fuer Administratoren (Phase 16a, Task 8): Datenbank, Scheduler-Laeufe,
 * Belegarchiv (freier Platz, nicht archivierte Belege), letzte Kettenpruefung, letzte Sicherung.
 */
import { promises as fs } from "node:fs";
import { dbInternal } from "@/lib/db";
import { checkDb } from "@/lib/health";
import path from "node:path";
import { archiveRoot } from "@/lib/archive/storage";
import { JOB_ORDER } from "@/domain/scheduler/runner";

export interface SystemHealth {
  db: boolean;
  scheduler: Record<string, string | null>;
  archive: { freeBytes: number | null; pending: number };
  attachments: { freeBytes: number | null };
  chain: { lastCheckedAt: string; valid: boolean } | null;
  backup: { lastOkAt: string } | null;
}

/** Freier Platz des Dateisystems unter `dir`; `ratio` = frei / gesamt (null, wenn nicht ermittelbar). */
export async function diskSpace(dir: string): Promise<{ freeBytes: number; ratio: number | null } | null> {
  try {
    const s = await fs.statfs(dir);
    const total = Number(s.blocks);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), ratio: total > 0 ? Number(s.bavail) / total : null };
  } catch {
    return null;
  }
}

/** Verzeichnis der Anhaenge (wie `src/lib/attachments/storage.ts`). */
export function attachmentsDir(): string {
  const dir = process.env.ATTACHMENTS_DIR || "./data/attachments";
  return path.isAbsolute(dir) ? dir : path.resolve(/*turbopackIgnore: true*/ process.cwd(), dir);
}

/** Letzter erfolgreicher Lauf je Scheduler-Job (Ende bzw. Start), null = nie. */
export async function lastOkByJob(): Promise<Record<string, Date | null>> {
  const out: Record<string, Date | null> = {};
  for (const job of JOB_ORDER) {
    const last = await dbInternal.schedulerRun.findFirst({
      where: { job, status: "OK" },
      orderBy: { startedAt: "desc" },
      select: { finishedAt: true, startedAt: true },
    });
    out[job] = last ? (last.finishedAt ?? last.startedAt) : null;
  }
  return out;
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
  for (const [job, at] of Object.entries(await lastOkByJob())) scheduler[job] = at ? at.toISOString() : null;
  const [invoicesPending, dunningsPending, chain] = await Promise.all([
    dbInternal.invoice.count({ where: { orgId, status: { not: "DRAFT" }, number: { not: null }, archivedDocuments: { none: {} } } }),
    dbInternal.dunning.count({ where: { pdfPath: null, invoice: { orgId } } }),
    dbInternal.chainVerification.findFirst({ where: { orgId }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true, valid: true } }),
  ]);
  return {
    db,
    scheduler,
    archive: { freeBytes: (await diskSpace(archiveRoot()))?.freeBytes ?? null, pending: invoicesPending + dunningsPending },
    attachments: { freeBytes: (await diskSpace(attachmentsDir()))?.freeBytes ?? null },
    chain: chain ? { lastCheckedAt: chain.checkedAt.toISOString(), valid: chain.valid } : null,
    backup: await readBackupStatus(),
  };
}
