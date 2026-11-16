/**
 * Ausgabe archivierter Dateien einer Eingangsrechnung (Original, ausgelesene XML, eingebettete
 * Anlagen). Vor jeder Ausgabe wird der SHA-256 gegen den gespeicherten Wert geprueft; bei
 * Abweichung oder fehlender Datei gibt es keine Ausgabe (Pflicht-Alarm, HTTP 500).
 */
import { dbInternal } from "@/lib/db";
import { readArchiveFile, sha256Hex } from "@/lib/archive/storage";
import { sanitizeFileName } from "@/domain/import/types";
import { sniffMime } from "@/lib/attachments/mime";
import { ArchiveTamperedError, NotFoundError, type IncomingArchiveKind } from "@/domain/errors";
import { onIncomingArchiveTampered } from "@/domain/notifications/hooks";
import { extractEmbeddedAttachment } from "./attachment-content";
import { MAX_PDF_ATTACHMENT_BYTES } from "./limits";
import { base64DecodedSize } from "./parse-common";

export type IncomingFileKind = "original" | "xml";
export interface IncomingFile {
  bytes: Buffer;
  mime: string;
  fileName: string;
}

const NOT_FOUND = "Eingangsrechnung nicht gefunden.";
const ATT_NOT_FOUND = "Anlage nicht gefunden.";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ODS = "application/vnd.oasis.opendocument.spreadsheet";
const ATTACHMENT_MIMES = new Set(["application/pdf", "image/png", "image/jpeg", "text/csv", XLSX, ODS]);

interface FileRow {
  id: string;
  originalFileName: string;
  originalMime: string;
  originalPath: string;
  originalSha256: string;
  xmlPath: string | null;
  xmlSha256: string | null;
}

async function loadRow(orgId: string, id: string): Promise<FileRow> {
  const row = await dbInternal.incomingInvoice.findFirst({
    where: { id, orgId },
    select: { id: true, originalFileName: true, originalMime: true, originalPath: true, originalSha256: true, xmlPath: true, xmlSha256: true },
  });
  if (!row) throw new NotFoundError(NOT_FOUND);
  return row;
}

async function readVerified(orgId: string, row: FileRow, path: string, sha256: string, kind: IncomingArchiveKind): Promise<Buffer> {
  const bytes = await readArchiveFile(path);
  if (bytes !== null && sha256Hex(bytes) === sha256) return bytes;
  await onIncomingArchiveTampered(orgId, { incomingInvoiceId: row.id, kind });
  throw new ArchiveTamperedError(row.id, kind, bytes === null ? "missing" : "hash-mismatch");
}

function baseName(name: string): string {
  return (sanitizeFileName(name) ?? "rechnung").replace(/\.[A-Za-z0-9]{1,5}$/, "");
}

/** Pfad und Hash der Rechnungs-XML: bei Hybriden die ausgelesene Datei, bei reiner XML das Original. */
function xmlSource(row: FileRow): { path: string; sha256: string; kind: IncomingArchiveKind } | null {
  if (row.xmlPath !== null && row.xmlSha256 !== null) return { path: row.xmlPath, sha256: row.xmlSha256, kind: "XML" };
  return row.originalMime === "application/xml" ? { path: row.originalPath, sha256: row.originalSha256, kind: "ORIGINAL" } : null;
}

export async function getIncomingFile(orgId: string, id: string, kind: IncomingFileKind): Promise<IncomingFile> {
  const row = await loadRow(orgId, id);
  if (kind === "original") {
    const bytes = await readVerified(orgId, row, row.originalPath, row.originalSha256, "ORIGINAL");
    return { bytes, mime: row.originalMime, fileName: row.originalFileName };
  }
  const src = xmlSource(row);
  if (!src) throw new NotFoundError(NOT_FOUND);
  const bytes = await readVerified(orgId, row, src.path, src.sha256, src.kind);
  return { bytes, mime: "application/xml", fileName: src.kind === "ORIGINAL" ? row.originalFileName : `${baseName(row.originalFileName)}.xml` };
}

function mimeMatches(claimed: string, bytes: Buffer): boolean {
  const sniffed = sniffMime(bytes);
  if (claimed === "application/pdf" || claimed === "image/png" || claimed === "image/jpeg") return sniffed === claimed;
  if (claimed === "text/csv") return sniffed === "text";
  if (claimed === XLSX) return sniffed === "ooxml-zip";
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b; // ODS: ZIP-Container
}

/** Eingebettete Anlage `n` (BG-24) aus der archivierten, hash-geprueften XML. */
export async function getIncomingAttachment(orgId: string, id: string, n: number): Promise<IncomingFile> {
  const row = await loadRow(orgId, id);
  const src = xmlSource(row);
  if (!src) throw new NotFoundError(ATT_NOT_FOUND);
  const xml = await readVerified(orgId, row, src.path, src.sha256, src.kind);
  const att = extractEmbeddedAttachment(xml.toString("utf8"), n);
  if (!att || att.base64 === "") throw new NotFoundError(ATT_NOT_FOUND);
  if (base64DecodedSize(att.base64) > MAX_PDF_ATTACHMENT_BYTES) throw new NotFoundError(ATT_NOT_FOUND);
  const compact = att.base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new NotFoundError(ATT_NOT_FOUND);
  const bytes = Buffer.from(compact, "base64");
  const claimed = att.mimeCode?.toLowerCase() ?? null;
  const mime = claimed !== null && ATTACHMENT_MIMES.has(claimed) && mimeMatches(claimed, bytes) ? claimed : "application/octet-stream";
  return { bytes, mime, fileName: sanitizeFileName(att.fileName ?? undefined) ?? `anlage-${n + 1}` };
}
