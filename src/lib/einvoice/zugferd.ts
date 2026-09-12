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
