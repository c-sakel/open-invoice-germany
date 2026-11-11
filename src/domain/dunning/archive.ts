/**
 * Mahnungsarchiv (Phase 16a, GoBD): das Mahn-PDF wird bei der ersten Ausgabe (oder nachts
 * durch den Scheduler) einmal gerendert, unter `ARCHIVE_DIR` abgelegt und per
 * `pdfPath`/`pdfSha256` an der Mahnung festgehalten. Danach liefert jeder Ausgabeweg nur
 * noch diese Bytes; fehlt die Datei oder weicht der SHA-256 ab, wird NIE neu gerendert
 * (`ARCHIVE_TAMPERED`, HTTP 500). Dateien werden nie ueberschrieben oder geloescht.
 */
import { dbInternal } from "@/lib/db";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { onArchiveFailed, onArchiveTampered } from "@/domain/notifications/hooks";
import { loadPdfTheme } from "@/domain/settings/theme";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { buildDunningPdfData } from "@/lib/pdf/dunning-data";
import { readArchiveFile, sha256Hex, writeArchiveFile } from "@/lib/archive/storage";

export interface DunningArchiveEntry {
  path: string;
  sha256: string;
}

/** Stellt sicher, dass das Mahn-PDF archiviert ist; liefert Pfad und SHA-256. */
export async function ensureDunningArchive(orgId: string, dunningId: string): Promise<DunningArchiveEntry> {
  const d = await dbInternal.dunning.findFirst({
    where: { id: dunningId, invoice: { orgId } },
    include: { invoice: { include: { org: true, customer: true } }, stage: true },
  });
  if (!d) throw new NotFoundError("Mahnung nicht gefunden.");
  if (d.pdfPath && d.pdfSha256) return { path: d.pdfPath, sha256: d.pdfSha256 };

  try {
    const theme = await loadPdfTheme(orgId, null, "DUNNING");
    const bytes = await renderDunningPdf(buildDunningPdfData(d, d.invoice), theme);
    const sha256 = sha256Hex(bytes);
    const stem = (d.number ?? d.id).replace(/[^A-Za-z0-9._-]/g, "_");
    const relPath = `${orgId}/${d.createdAt.getUTCFullYear()}/${stem}-${sha256.slice(0, 12)}.pdf`;
    await writeArchiveFile(relPath, bytes);
    const res = await dbInternal.dunning.updateMany({ where: { id: dunningId, pdfPath: null }, data: { pdfPath: relPath, pdfSha256: sha256 } });
    if (res.count === 1) return { path: relPath, sha256 };
    // Paralleler Aufruf war schneller: dessen Eintrag gilt.
    const winner = await dbInternal.dunning.findUnique({ where: { id: dunningId }, select: { pdfPath: true, pdfSha256: true } });
    if (winner?.pdfPath && winner.pdfSha256) return { path: winner.pdfPath, sha256: winner.pdfSha256 };
    throw new Error(`Mahnungsarchiv der Mahnung ${dunningId} nicht lesbar.`);
  } catch (e) {
    await onArchiveFailed(orgId, { invoiceId: d.invoiceId, message: e instanceof Error ? e.message : String(e), at: new Date() });
    throw e;
  }
}

/** Liefert das archivierte Mahn-PDF mit Hashpruefung (nie Neu-Rendern). */
export async function getArchivedDunningPdf(orgId: string, dunningId: string): Promise<Buffer> {
  const entry = await ensureDunningArchive(orgId, dunningId);
  const bytes = await readArchiveFile(entry.path);
  if (bytes && sha256Hex(bytes) === entry.sha256) return bytes;
  const d = await dbInternal.dunning.findFirst({ where: { id: dunningId, invoice: { orgId } }, select: { invoiceId: true } });
  const invoiceId = d?.invoiceId ?? dunningId;
  // Kennung "MAHNUNG-PDF" in der Benachrichtigung; der Fehler traegt die Dateiart PDF.
  await onArchiveTampered(orgId, { invoiceId, kind: "MAHNUNG-PDF" });
  throw new ArchiveTamperedError(invoiceId, "PDF", bytes ? "hash-mismatch" : "missing");
}
