/**
 * Einziger Lesepfad (org-gescoped: fremde oder unbekannte Rechnung -> NotFoundError) fuer ausgegebene Rechnungsdateien (Phase 16a, GoBD): archiviert beim
 * ersten Abruf (`ensureInvoiceArchive`) und liefert danach ausschliesslich die archivierten
 * Bytes. Fehlt die Datei oder weicht ihr SHA-256 vom Archivsatz ab, wird NIE neu gerendert:
 * Benachrichtigung `ARCHIVE_TAMPERED` und `ArchiveTamperedError` (HTTP 500).
 */
import { dbInternal } from "@/lib/db";
import { ArchiveTamperedError, NotFoundError } from "@/domain/errors";
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

export interface InvoiceArchiveInfo {
  archived: boolean;
  documents: Array<{ kind: ArchiveKind; sha256: string; source: string; createdAt: Date }>;
}

/** Archivstand einer Rechnung (ohne Dateipfade) fuer REST und MCP; archiviert NICHT selbst. */
export async function getInvoiceArchiveInfo(orgId: string, invoiceId: string): Promise<InvoiceArchiveInfo> {
  const inv = await dbInternal.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { id: true } });
  if (!inv) throw new NotFoundError("Rechnung nicht gefunden.");
  const rows = await dbInternal.archivedDocument.findMany({
    where: { invoiceId },
    orderBy: { kind: "asc" },
    select: { kind: true, sha256: true, source: true, createdAt: true },
  });
  const documents: InvoiceArchiveInfo["documents"] = [];
  for (const r of rows) {
    if (r.kind === "PDF" || r.kind === "CII" || r.kind === "UBL") documents.push({ kind: r.kind, sha256: r.sha256, source: r.source, createdAt: r.createdAt });
  }
  return { archived: documents.length > 0, documents };
}
