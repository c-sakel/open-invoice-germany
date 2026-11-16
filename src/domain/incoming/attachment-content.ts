/**
 * Eingebettete Anlagen (BG-24) aus der archivierten Rechnungs-XML. Dieselbe Auswahl und Reihenfolge
 * wie beim Auslesen (`parse-ubl.ts`, `parse-cii.ts`): Index nach dem Filter.
 */
import { attr, find, findAll, text } from "@/lib/xml/dom";
import { CII_NS, classifyRoot, loadXml, UBL_NS } from "./detect";
import { MAX_LIST_ITEMS } from "./limits";

export interface EmbeddedAttachment {
  mimeCode: string | null;
  fileName: string | null;
  base64: string;
}

/** Anlage `n` (0-basiert) oder `null`, wenn es sie nicht gibt oder sie nur ein externer Verweis ist. */
export function extractEmbeddedAttachment(xml: string, n: number): EmbeddedAttachment | null {
  const root = loadXml(xml);
  const cls = classifyRoot(root);
  let bins: ReturnType<typeof find>[] = [];
  if (cls.syntax === "UBL") {
    bins = findAll(root, UBL_NS, "cac:AdditionalDocumentReference")
      .map((d) => ({ d, bin: find(d, UBL_NS, "cac:Attachment/cbc:EmbeddedDocumentBinaryObject") }))
      .filter(({ d, bin }) => bin !== null || find(d, UBL_NS, "cac:Attachment/cac:ExternalReference/cbc:URI") !== null)
      .map(({ bin }) => bin);
  } else if (cls.syntax === "CII") {
    const agreement = find(root, CII_NS, "rsm:SupplyChainTradeTransaction/ram:ApplicableHeaderTradeAgreement");
    if (agreement) {
      bins = findAll(agreement, CII_NS, "ram:AdditionalReferencedDocument")
        .map((d) => ({ d, bin: find(d, CII_NS, "ram:AttachmentBinaryObject") }))
        .filter(({ d, bin }) => bin !== null || find(d, CII_NS, "ram:URIID") !== null)
        .map(({ bin }) => bin);
    }
  }
  if (!Number.isInteger(n) || n < 0 || n >= Math.min(bins.length, MAX_LIST_ITEMS)) return null;
  const bin = bins[n];
  if (!bin) return null;
  return { mimeCode: attr(bin, "mimeCode"), fileName: attr(bin, "filename"), base64: text(bin) ?? "" };
}
