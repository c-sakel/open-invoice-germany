/**
 * Nachlauf des Belegarchivs (Phase 16a): archiviert festgeschriebene Rechnungen und
 * Mahnungen, die noch nie ausgegeben wurden. Seriell (ChangeLog-Kette), je Lauf hoechstens
 * `ARCHIVE_BATCH` Rechnungen und `ARCHIVE_BATCH` Mahnungen, aelteste zuerst. Fehler
 * einzelner Belege (bereits als ARCHIVE_FAILED gemeldet) stoppen den Lauf nicht.
 */
import { dbInternal } from "@/lib/db";
import { ensureInvoiceArchive } from "@/domain/invoice/archive";
import { ensureDunningArchive } from "@/domain/dunning/archive";

export const ARCHIVE_BATCH = 50;

export async function runArchiveJob(now: Date, opts: { batch?: number } = {}): Promise<{ archived: number; failed: number }> {
  const batch = opts.batch ?? ARCHIVE_BATCH;
  let archived = 0;
  let failed = 0;

  const invoices = await dbInternal.invoice.findMany({
    where: { status: { not: "DRAFT" }, number: { not: null }, archivedDocuments: { none: {} } },
    orderBy: [{ finalizedAt: "asc" }, { id: "asc" }],
    take: batch,
    select: { id: true, orgId: true },
  });
  for (const inv of invoices) {
    try {
      await ensureInvoiceArchive(inv.orgId, inv.id, "SCHEDULER", now);
      archived++;
    } catch (e) {
      failed++;
      console.error("archive-job: Rechnung nicht archiviert", inv.id, e instanceof Error ? e.message : e);
    }
  }

  const dunnings = await dbInternal.dunning.findMany({
    where: { pdfPath: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batch,
    select: { id: true },
  });
  for (const d of dunnings) {
    try {
      await ensureDunningArchive(d.id);
      archived++;
    } catch (e) {
      failed++;
      console.error("archive-job: Mahnung nicht archiviert", d.id, e instanceof Error ? e.message : e);
    }
  }
  return { archived, failed };
}
