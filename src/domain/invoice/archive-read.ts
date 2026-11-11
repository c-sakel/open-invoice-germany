/**
 * Einziger Lesepfad fuer ausgegebene Rechnungsdateien (Phase 16a, GoBD): archiviert beim
 * ersten Abruf (`ensureInvoiceArchive`) und liefert danach ausschliesslich die archivierten
 * Bytes. Fehlt die Datei oder weicht ihr SHA-256 vom Archivsatz ab, wird NIE neu gerendert:
 * Benachrichtigung `ARCHIVE_TAMPERED` und `ArchiveTamperedError` (HTTP 500).
 */
import { dbInternal } from "@/lib/db";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
import { onArchiveTampered } from "@/domain/notifications/hooks";
import { readArchiveFile, sha256Hex } from "@/lib/archive/storage";
import { ensureInvoiceArchive, type ArchiveKind, type ArchiveSource } from "./archive";

export async function getArchivedInvoiceFile(invoiceId: string, kind: ArchiveKind, opts: { source?: ArchiveSource } = {}): Promise<Buffer> {
  const set = await ensureInvoiceArchive(invoiceId, opts.source ?? "OUTPUT");
  const entry = set[kind];
  const bytes = await readArchiveFile(entry.path);
  if (bytes && sha256Hex(bytes) === entry.sha256) return bytes;

  const inv = await dbInternal.invoice.findUnique({ where: { id: invoiceId }, select: { orgId: true } });
  if (!inv) throw new NotFoundError("Rechnung nicht gefunden.");
  await onArchiveTampered(inv.orgId, { invoiceId, kind });
  throw new ArchiveTamperedError(invoiceId, kind, bytes ? "hash-mismatch" : "missing");
}
