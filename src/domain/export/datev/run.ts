/**
 * Exportlauf: schreibt Protokoll (DatevExport + DatevExportItem), ChangeLog und ActivityLog in einer Transaktion
 * und legt die ZIP write-once im Archivverzeichnis ab (`datev/<orgId>/<exportId>.zip`). Laeufe sind je Organisation
 * seriell (Organisationssperre); ohne gueltige Bestaetigung der Kontenzuordnung entsteht nie eine Datei.
 */
import { randomUUID } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { lockOrganization } from "@/lib/db-lock";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { readArchiveFile, removeArchiveFile, sha256Hex, writeArchiveFile } from "@/lib/archive/storage";
import { buildDatevRun, parseExportRequest, type DatevRepeat } from "./plan";
import { DatevExportError } from "./errors";
import { storedExportSchema, type StoredFile, type StoredManual } from "./stored";

export { planDatevExport, type DatevPlan } from "./plan";
export { datevStatus, type DatevStatus } from "./late";

const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

export interface DatevExportView {
  id: string;
  mode: "PERIOD" | "SUPPLEMENT";
  fromMonth: string;
  toMonth: string;
  repeat: boolean;
  lineCount: number;
  itemCount: number;
  manualCount: number;
  debtorCount: number;
  sha256: string;
  files: StoredFile[];
  manual: StoredManual[];
  repeats: (Omit<DatevRepeat, "createdAt"> & { createdAt: Date })[];
  createdBy: string;
  createdAt: Date;
}

const EXPORT_SELECT = {
  id: true, mode: true, fromMonth: true, toMonth: true, repeat: true, lineCount: true, itemCount: true, manualCount: true,
  debtorCount: true, sha256: true, filesJson: true, createdBy: true, createdAt: true,
} as const;

interface ExportRow {
  id: string;
  mode: string;
  fromMonth: string;
  toMonth: string;
  repeat: boolean;
  lineCount: number;
  itemCount: number;
  manualCount: number;
  debtorCount: number;
  sha256: string;
  filesJson: string;
  createdBy: string;
  createdAt: Date;
}

function toView(row: ExportRow): DatevExportView {
  let stored = { files: [] as StoredFile[], monthHashes: {} as Record<string, string>, repeats: [] as { month: string; exportId: string; createdAt: string; contentSha256: string; identical: boolean | null }[], manual: [] as StoredManual[] };
  try {
    const parsed = storedExportSchema.safeParse(JSON.parse(row.filesJson));
    if (parsed.success) stored = parsed.data;
  } catch {
    /* Beschreibung nicht lesbar: leere Listen */
  }
  return {
    id: row.id,
    mode: row.mode === "SUPPLEMENT" ? "SUPPLEMENT" : "PERIOD",
    fromMonth: row.fromMonth,
    toMonth: row.toMonth,
    repeat: row.repeat,
    lineCount: row.lineCount,
    itemCount: row.itemCount,
    manualCount: row.manualCount,
    debtorCount: row.debtorCount,
    sha256: row.sha256,
    files: stored.files,
    manual: stored.manual,
    repeats: stored.repeats.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/**
 * Fuehrt den Export aus. Fehler: 422 (nicht bestaetigt, Zeitraum, fehlende Konten mit Liste), 409
 * (Zeitraum schon exportiert ohne `repeat`, nichts zu exportieren). `dryRun` des Auftrags wird hier ignoriert;
 * die Vorschau ist `planDatevExport`.
 */
export async function runDatevExport(orgId: string, rawReq: unknown, actor: string, now: Date = new Date()): Promise<DatevExportView> {
  const req = parseExportRequest(rawReq);
  let writtenPath: string | null = null;
  try {
    const row = await withChangeLogRetry(() =>
      dbInternal.$transaction(async (tx) => {
        if (writtenPath) {
          await removeArchiveFile(writtenPath);
          writtenPath = null;
        }
        await lockOrganization(tx, orgId);
        const built = await buildDatevRun(tx, orgId, req, now);
        const { plan } = built;
        if (req.mode === "PERIOD" && plan.repeats.length > 0 && !req.repeat) {
          throw new DatevExportError("ALREADY_EXPORTED", "Fuer diese Monate existiert bereits ein Export. Zum Wiederholen die Wiederholung ausdruecklich freigeben.", {
            months: plan.repeats.map((r) => r.month),
          });
        }
        if (plan.issues.length > 0) {
          const codes = plan.issues.map((i) => i.code);
          const code = codes.includes("MISSING_MAPPING") ? "MISSING_MAPPING" : plan.issues[0].code;
          throw new DatevExportError(code, `Export nicht moeglich: ${plan.issues.length} fehlende Angabe(n) in der Kontenzuordnung bzw. den Einstellungen.`, { issues: plan.issues });
        }
        if (plan.items.length === 0 || built.zip === null) {
          throw new DatevExportError(
            "NOTHING_TO_EXPORT",
            req.mode === "SUPPLEMENT" ? "Keine nachtraeglichen Buchungen in bereits exportierten Monaten." : "Keine Belege oder Zahlungen im Zeitraum.",
          );
        }
        const id = randomUUID();
        const archivePath = `datev/${orgId}/${id}.zip`;
        const zipSha = sha256Hex(built.zip);
        await writeArchiveFile(archivePath, built.zip);
        writtenPath = archivePath;
        const primary = plan.items.filter((i) => !i.covered);
        const created = await tx.datevExport.create({
          data: {
            id,
            orgId,
            mode: req.mode,
            fromMonth: req.from,
            toMonth: req.to,
            repeat: req.repeat === true,
            lineCount: plan.lineCount,
            itemCount: primary.length,
            manualCount: plan.manualCount,
            debtorCount: plan.debtorCount,
            sha256: zipSha,
            archivePath,
            filesJson: JSON.stringify(built.stored),
            settingsJson: built.settingsJson,
            createdBy: actor,
            createdAt: now,
          },
          select: EXPORT_SELECT,
        });
        await tx.datevExportItem.createMany({
          data: plan.items.map((i) => ({
            orgId,
            exportId: id,
            itemKey: i.key,
            invoiceId: i.invoiceId,
            paymentId: i.paymentId,
            customerId: i.customerId,
            month: i.month,
            status: i.status,
            lineCount: i.lineCount,
            amountCents: i.amountCents,
            reason: i.reason,
            warning: i.warning,
            createdAt: now,
          })),
        });
        await appendChangeLog(tx, {
          orgId,
          entity: "DATEV_EXPORT",
          entityId: id,
          action: "EXPORT",
          actor,
          at: now,
          diff: { mode: req.mode, from: req.from, to: req.to, repeat: req.repeat === true, lines: plan.lineCount, items: primary.length, manual: plan.manualCount, sha256: zipSha },
        });
        await logActivity(tx, {
          orgId,
          entityType: "DATEV",
          entityId: id,
          type: "DATEV_EXPORT_CREATED",
          actor,
          at: now,
          data: { mode: req.mode, from: req.from, to: req.to, lines: plan.lineCount, items: primary.length, manual: plan.manualCount },
        });
        return created;
      }, TX_OPTIONS),
    );
    return toView(row);
  } catch (e) {
    if (writtenPath) await removeArchiveFile(writtenPath).catch(() => undefined);
    throw e;
  }
}

/** ZIP eines Laufs (Archivdatei, Pruefsumme gegen das Protokoll). Fremde oder unbekannte Laeufe: NOT_FOUND. */
export async function readDatevExportFile(orgId: string, exportId: string): Promise<{ bytes: Buffer; filename: string }> {
  const row = await dbInternal.datevExport.findFirst({
    where: { id: exportId, orgId },
    select: { id: true, mode: true, fromMonth: true, toMonth: true, sha256: true, archivePath: true },
  });
  if (!row) throw new DatevExportError("NOT_FOUND", "Export nicht gefunden.");
  const bytes = await readArchiveFile(row.archivePath);
  if (bytes === null) throw new DatevExportError("FILE_TAMPERED", "Die Exportdatei fehlt im Archiv.");
  if (sha256Hex(bytes) !== row.sha256) throw new DatevExportError("FILE_TAMPERED", "Die Exportdatei stimmt nicht mehr mit dem Protokoll ueberein.");
  const range = row.fromMonth === row.toMonth ? row.fromMonth : `${row.fromMonth}_${row.toMonth}`;
  return { bytes, filename: `DATEV-Export_${range}${row.mode === "SUPPLEMENT" ? "_Nachtrag" : ""}_${row.id.slice(0, 8)}.zip` };
}

export async function listDatevExports(orgId: string, page: { limit?: number; offset?: number } = {}): Promise<DatevExportView[]> {
  const rows = await dbInternal.datevExport.findMany({
    where: { orgId },
    select: EXPORT_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(page.limit ?? 50, 1), 200),
    skip: Math.max(page.offset ?? 0, 0),
  });
  return rows.map(toView);
}

/** Einzelnes Protokoll (inkl. Posten, seitenweise). Fremde oder unbekannte Laeufe: NOT_FOUND. */
export async function getDatevExport(orgId: string, exportId: string): Promise<DatevExportView> {
  const row = await dbInternal.datevExport.findFirst({ where: { id: exportId, orgId }, select: EXPORT_SELECT });
  if (!row) throw new DatevExportError("NOT_FOUND", "Export nicht gefunden.");
  return toView(row);
}
