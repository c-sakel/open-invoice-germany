/**
 * Einziger Lesepfad (org-gescoped: fremde oder unbekannte Rechnung -> NotFoundError) fuer ausgegebene Rechnungsdateien (Phase 16a, GoBD): archiviert beim
 * ersten Abruf (`ensureInvoiceArchive`) und liefert danach ausschliesslich die archivierten
 * Bytes. Fehlt die Datei oder weicht ihr SHA-256 vom Archivsatz ab, wird NIE neu gerendert:
 * Benachrichtigung `ARCHIVE_TAMPERED` und `ArchiveTamperedError` (HTTP 500).
 */
import { ArchiveTamperedError } from "@/domain/errors";
import { onArchiveTampered } from "@/domain/notifications/hooks";
import { readArchiveFile, sha256Hex } from "@/lib/archive/storage";
import { ensureInvoiceArchive, type ArchiveKind, type ArchiveSource } from "./archive";

export async function getArchivedInvoiceFile(orgId: string, invoiceId: string, kind: ArchiveKind, opts: { source?: ArchiveSource } = {}): Promise<Buffer> {
  const set = await ensureInvoiceArchive(orgId, invoiceId, opts.source ?? "OUTPUT");
  const entry = set[kind];
  const bytes = await readArchiveFile(entry.path);
  if (bytes && sha256Hex(bytes) === entry.sha256) return bytes;

  await onArchiveTampered(orgId, { invoiceId, kind });
  throw new ArchiveTamperedError(invoiceId, kind, bytes ? "hash-mismatch" : "missing");
}
