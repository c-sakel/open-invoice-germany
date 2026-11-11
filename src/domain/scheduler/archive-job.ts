/**
 * Nachlauf des Belegarchivs (Phase 16a): archiviert festgeschriebene Rechnungen und
 * Mahnungen, die noch nie ausgegeben wurden. Seriell (ChangeLog-Kette). Je Lauf und Art
 * hoechstens `batch` (Default Env `ARCHIVE_JOB_BATCH`, sonst `ARCHIVE_BATCH`) erfolgreiche Archivierungen bei hoechstens
 * `ARCHIVE_MAX_ATTEMPTS` Versuchen; fehlgeschlagene Belege werden im selben Lauf
 * uebersprungen (sie blockieren die uebrigen nicht). `ARCHIVE_FAILED` wird je Beleg und
 * Tag hoechstens einmal gemeldet (Dedupe-Schluessel in `onArchiveFailed`).
 */
import { dbInternal } from "@/lib/db";
import { ensureInvoiceArchive } from "@/domain/invoice/archive";
import { ensureDunningArchive } from "@/domain/dunning/archive";

export const ARCHIVE_BATCH = 50;
export const ARCHIVE_MAX_ATTEMPTS = 200;

/**
 * Batchgroesse aus `ARCHIVE_JOB_BATCH` (Ganzzahl 1..ARCHIVE_MAX_ATTEMPTS), z. B. kleiner fuer
 * weniger Lastspitzen beim Backfill nach dem ersten Deploy; ungueltig/leer -> `ARCHIVE_BATCH`.
 */
export function archiveBatchFromEnv(raw: string | undefined = process.env.ARCHIVE_JOB_BATCH): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return ARCHIVE_BATCH;
  const n = Number(raw.trim());
  return n >= 1 && n <= ARCHIVE_MAX_ATTEMPTS ? n : ARCHIVE_BATCH;
}

export async function runArchiveJob(now: Date, opts: { batch?: number; maxAttempts?: number } = {}): Promise<{ archived: number; failed: number }> {
  const batch = opts.batch ?? archiveBatchFromEnv();
  const maxAttempts = opts.maxAttempts ?? ARCHIVE_MAX_ATTEMPTS;
  let archived = 0;
  let failed = 0;

  const invoices = await dbInternal.invoice.findMany({
    where: { status: { not: "DRAFT" }, number: { not: null }, archivedDocuments: { none: {} } },
    orderBy: [{ finalizedAt: "asc" }, { id: "asc" }],
    take: maxAttempts,
    select: { id: true, orgId: true },
  });
  let ok = 0;
  for (const inv of invoices) {
    if (ok >= batch) break;
    try {
      await ensureInvoiceArchive(inv.orgId, inv.id, "SCHEDULER", now);
      ok++;
    } catch (e) {
      failed++;
      console.error("archive-job: Rechnung nicht archiviert", inv.id, e instanceof Error ? e.message : e);
    }
  }
  archived += ok;

  const dunnings = await dbInternal.dunning.findMany({
    where: { pdfPath: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: maxAttempts,
    select: { id: true, invoice: { select: { orgId: true } } },
  });
  ok = 0;
  for (const d of dunnings) {
    if (ok >= batch) break;
    try {
      await ensureDunningArchive(d.invoice.orgId, d.id);
      ok++;
    } catch (e) {
      failed++;
      console.error("archive-job: Mahnung nicht archiviert", d.id, e instanceof Error ? e.message : e);
    }
  }
  archived += ok;
  return { archived, failed };
}
