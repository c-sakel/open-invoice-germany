/**
 * Mahnungsarchiv (Phase 16a, GoBD): das Mahn-PDF wird bei der ersten Ausgabe (oder nachts
 * durch den Scheduler) einmal gerendert, unter `ARCHIVE_DIR` abgelegt und per
 * `pdfPath`/`pdfSha256` an der Mahnung festgehalten. Danach liefert jeder Ausgabeweg nur
 * noch diese Bytes; fehlt die Datei oder weicht der SHA-256 ab, wird NIE neu gerendert
 * (`ARCHIVE_TAMPERED`, HTTP 500). Dateien werden nie ueberschrieben oder geloescht.
 * Das Festhalten schreibt in derselben Transaktion den ChangeLog-Eintrag `DUNNING/ARCHIVE`
 * (sha256, source); Mahnungen von vor der Archiv-Epoche tragen `source = BACKFILL`
 * (nachgerendert mit dem Stand zum Zeitpunkt der Nacharchivierung, siehe LIMITATIONEN).
 */
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { onArchiveFailed, onArchiveTampered } from "@/domain/notifications/hooks";
import { loadPdfTheme } from "@/domain/settings/theme";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { buildDunningPdfData } from "@/lib/pdf/dunning-data";
import { readArchiveFile, sha256Hex, writeArchiveFile } from "@/lib/archive/storage";

const ARCHIVE_EPOCH_KEY = "archive-epoch";

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

  // Kein Archivpfad, aber die Kette traegt bereits ein ARCHIVE: an der Anwendung vorbei
  // zurueckgesetzt. Nie still neu rendern — Pflicht-Alarm und 500.
  const archivedBefore = await dbInternal.changeLog.findFirst({
    where: { orgId, entity: "DUNNING", entityId: dunningId, action: "ARCHIVE" },
    select: { id: true },
  });
  if (archivedBefore) {
    await onArchiveTampered(orgId, { invoiceId: d.invoiceId, kind: "MAHNUNG-PDF" });
    throw new ArchiveTamperedError(d.invoiceId, "PDF", "record-missing");
  }

  try {
    const theme = await loadPdfTheme(orgId, null, "DUNNING");
    const bytes = await renderDunningPdf(buildDunningPdfData(d, d.invoice), theme);
    const sha256 = sha256Hex(bytes);
    const stem = (d.number ?? d.id).replace(/[^A-Za-z0-9._-]/g, "_");
    const relPath = `${orgId}/${d.createdAt.getUTCFullYear()}/${stem}-${sha256.slice(0, 12)}.pdf`;
    await writeArchiveFile(relPath, bytes);
    const marker = await dbInternal.systemMarker.findUnique({ where: { key: ARCHIVE_EPOCH_KEY }, select: { at: true } });
    const source = marker && d.createdAt.getTime() < marker.at.getTime() ? "BACKFILL" : "OUTPUT";
    const now = new Date();
    for (let attempt = 0; ; attempt++) {
      try {
        const won = await dbInternal.$transaction(async (tx) => {
          const res = await tx.dunning.updateMany({ where: { id: dunningId, pdfPath: null }, data: { pdfPath: relPath, pdfSha256: sha256 } });
          if (res.count !== 1) return false;
          await appendChangeLog(tx, {
            orgId,
            entity: "DUNNING",
            entityId: dunningId,
            action: "ARCHIVE",
            actor: "system",
            at: now,
            diff: { invoiceId: d.invoiceId, pdf: sha256, source },
          });
          return true;
        });
        if (won) return { path: relPath, sha256 };
        break;
      } catch (e) {
        // Kettenkonflikt mit einem anderen ChangeLog-Schreiber: genau einmal wiederholen.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || attempt >= 1) throw e;
      }
    }
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
