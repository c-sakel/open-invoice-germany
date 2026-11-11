/**
 * Normalisiert ein pdfkit-PDF fuer Regressionsvergleiche (Phase 16g, Task 1): entfernt die
 * zeitabhaengigen Metadaten (Info-Dictionary, Trailer-ID, XMP-Zeitstempel/-IDs), damit zwei
 * Renderings derselben Eingabe denselben Hash liefern.
 */
import { createHash } from "node:crypto";

export function normalizedPdfHash(pdf: Buffer): string {
  const text = pdf
    .toString("latin1")
    .replace(/\/CreationDate \([^)]*\)/g, "/CreationDate ()")
    .replace(/\/ModDate \([^)]*\)/g, "/ModDate ()")
    .replace(/\(D:\d{14}[^)]*\)/g, "(D:)")
    .replace(/\/ID \[[^\]]*\]/g, "/ID []")
    .replace(/<xmp:(CreateDate|ModifyDate|MetadataDate)>[^<]*<\/xmp:\1>/g, "<xmp:$1></xmp:$1>")
    .replace(/<xmpMM:(DocumentID|InstanceID)>[^<]*<\/xmpMM:\1>/g, "<xmpMM:$1></xmpMM:$1>")
    .replace(/(xmp|xmpMM):(CreateDate|ModifyDate|MetadataDate|DocumentID|InstanceID)="[^"]*"/g, '$1:$2=""');
  return createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex");
}
