/**
 * Erzeugt ein ZUGFeRD/Factur-X-Hybrid-PDF: die CII/Factur-X-XML (EN-16931-Schematron-
 * validiert) wird als Anhang direkt waehrend des pdfkit-Renderns eingebettet
 * (`renderInvoicePdf(..., { attachments: [...] })` → `doc.file(...)`), nicht mehr im
 * Nachgang ueber `pdf-lib`.
 *
 * Task 6 (Spec R10): das Ergebnis ist PDF/A-3b (eingebettete Schriften, sRGB-OutputIntent,
 * `/AF`/`/AFRelationship`, Factur-X-XMP-Erweiterungsschema) — `pdf-lib` erzeugte das nicht
 * und entfaellt, weil dies der einzige Nutzungsort war. Der eingebettete XML-Teil bleibt
 * fachlich fuehrend.
 */
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import type { PdfTheme } from "@/lib/pdf/theme";
import { buildFacturXCII } from "./cii";
import type { EInvoiceData } from "./types";

const FACTUR_X_FILENAME = "factur-x.xml";

export async function renderZugferdPdf(data: EInvoiceData, theme: PdfTheme): Promise<Buffer> {
  const cii = buildFacturXCII(data);
  return renderInvoicePdf(data, theme, {
    attachments: [
      {
        name: FACTUR_X_FILENAME,
        bytes: Buffer.from(cii, "utf8"),
        relationship: "Alternative",
        type: "text/xml",
        description: "Factur-X / ZUGFeRD — strukturierte Rechnung (EN 16931)",
      },
    ],
  });
}

/**
 * Das "normale" Rechnungs-PDF (Download, API, Anhaenge): alle nicht-Entwurf-Belege
 * (festgeschrieben, versendet, (teil)bezahlt, storniert) tragen IMMER die eingebettete ZUGFeRD/Factur-X-XML; nur echte Entwuerfe bleiben
 * ein schlichtes PDF. Blockiert den PDF-Export nicht — scheitert der XML-Bau, wird mit
 * Fehlerlog auf das schlichte PDF zurueckgefallen (Validierung bleibt im XRechnung-/
 * ZUGFeRD-Export und im KoSIT-CI-Gate).
 */
export async function renderInvoiceDocumentPdf(data: EInvoiceData, theme: PdfTheme, status: string): Promise<Buffer> {
  // Nur Entwuerfe bleiben schlicht. Jeder festgeschriebene Status (FINALIZED, SENT, PAID,
  // PARTIALLY_PAID, CANCELLED) traegt die XML — die Webshop-Rechnungen stehen sofort auf PAID.
  if (status === "DRAFT") return renderInvoicePdf(data, theme);
  try {
    return await renderZugferdPdf(data, theme);
  } catch (err) {
    console.error("ZUGFeRD-Einbettung fehlgeschlagen, liefere schlichtes PDF:", err instanceof Error ? err.message : err);
    return renderInvoicePdf(data, theme);
  }
}
