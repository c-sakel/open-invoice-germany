/**
 * PDF/A-3b-Fabrik fuer alle pdfkit-Renderer (Rechnung, Lieferschein, Mahnung) — Task 6,
 * Spec R10. Ersetzt die bisherigen direkten `new PDFDocument(...)`-Aufrufe in
 * `invoice-pdf.ts`, `delivery-note-pdf.ts` und `dunning-pdf.ts`.
 *
 * `font: null` ist zwingend: pdfkit oeffnet im Konstruktor sonst die eingebaute
 * Standard-Helvetica (AFM, nicht eingebettet) und legt sie im Font-Cache unter dem Namen
 * "Helvetica" ab. Ein spaeteres `registerFont("Helvetica", ...)` aendert daran nichts mehr —
 * `doc.font("Helvetica")` liefert weiterhin die Standardschrift, die Datei bleibt nicht
 * PDF/A-konform (Klausel 6.2.11.4.1, praktisch nachgewiesen, siehe Spec R10). Mit
 * `font: null` bleibt `doc._font` leer, bis der erste explizite `doc.font(...)`-Aufruf im
 * jeweiligen Renderer erfolgt — genau dort greift dann `registerPdfFonts`.
 */
import PDFDocument from "pdfkit";
import type { PdfMargins } from "./layout";
import { registerPdfFonts } from "./fonts";

export interface CreatePdfDocumentOptions {
  size: string | number[];
  margins: PdfMargins;
  /** Content-Stream-Kompression, siehe `PdfTheme.compress` (Default `true`). */
  compress?: boolean;
  info?: PDFKit.DocumentInfo;
  /** Muss `true` sein — PDF/A-3b ist ab Task 6 fuer alle Belegtypen verbindlich. */
  pdfa: true;
}

/**
 * Erzeugt ein PDF/A-3b-konformes pdfkit-Dokument mit eingebetteten Liberation-Sans-
 * Schnitten. `bufferPages: true` bleibt gesetzt (die Renderer paginieren manuell).
 */
export function createPdfDocument(options: CreatePdfDocumentOptions): PDFKit.PDFDocument {
  // pdfkit unterstuetzt `font: null` zur Laufzeit ausdruecklich (siehe `initFonts` in
  // pdfkit.js), die mitgelieferten Typen kennen dafuer aber nur `string | undefined`.
  // Gezielter Interop-Cast auf eine unvollstaendige Drittanbieter-Deklaration, kein `any`.
  const pdfDocumentOptions = {
    size: options.size,
    margins: options.margins,
    bufferPages: true,
    compress: options.compress ?? true,
    info: options.info,
    pdfVersion: "1.7",
    subset: "PDF/A-3b",
    font: null,
  } as unknown as PDFKit.PDFDocumentOptions;

  const doc = new PDFDocument(pdfDocumentOptions);
  registerPdfFonts(doc);
  // Ohne `font: null` wuerde der Konstruktor selbst `doc.font("Helvetica")` aufrufen —
  // hier holen wir das explizit nach, jetzt aber NACH `registerPdfFonts`, sodass
  // "Helvetica" bereits auf den eingebetteten Liberation-Sans-Regular-Buffer zeigt statt
  // auf pdfkits eingebaute AFM-Standardschrift. Noetig, weil nicht jede Zeichenstelle im
  // Bestand vor dem ersten `doc.text(...)` selbst `.font(...)` aufruft.
  doc.font("Helvetica");
  return doc;
}
