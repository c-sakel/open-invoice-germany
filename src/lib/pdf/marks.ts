/**
 * Falz-/Lochmarken und Seitenzahlen (Phase 7, Task 3, §36). Reine pdfkit-Hilfsfunktionen,
 * DIN 5008 orientiert (Falzmarken bei 105 mm/210 mm ab Oberkante, Lochmarke bei 148,5 mm).
 */
import type { PdfTheme } from "./theme";

/** 1 mm in PDF-Punkt (pt), siehe Task-3-Facts. */
export const MM_TO_PT = 2.834645;

/** Rechnet Millimeter in PDF-Punkt (pt) um. */
export function mm(value: number): number {
  return value * MM_TO_PT;
}

const MARK_COLOR = "#999999";
const MARK_LINE_WIDTH = 0.3;
const MARK_START_X_MM = 3;
const MARK_LENGTH_MM = 5;

function drawMarkLine(doc: PDFKit.PDFDocument, yMm: number): void {
  const x = mm(MARK_START_X_MM);
  const y = mm(yMm);
  doc.save();
  doc.lineWidth(MARK_LINE_WIDTH).strokeColor(MARK_COLOR);
  doc.moveTo(x, y).lineTo(x + mm(MARK_LENGTH_MM), y).stroke();
  doc.restore();
}

/** Falzmarken für DIN-lang-Fensterumschläge: 105 mm und 210 mm von oben. */
export function drawFoldMarks(doc: PDFKit.PDFDocument): void {
  drawMarkLine(doc, 105);
  drawMarkLine(doc, 210);
}

/** Lochmarke (Locher-Mittelpunkt) bei 148,5 mm von oben. */
export function drawPunchMark(doc: PDFKit.PDFDocument): void {
  drawMarkLine(doc, 148.5);
}

/**
 * Trägt "Seite x von y" unten rechts auf jede gepufferte Seite ein — MUSS erst NACH dem
 * gesamten Inhalt aufgerufen werden (pdfkit `bufferPages: true`), da erst dann die
 * Gesamtseitenzahl feststeht.
 */
export function drawPageNumbers(doc: PDFKit.PDFDocument, theme: PdfTheme): void {
  const range = doc.bufferedPageRange();
  const marginRight = mm(theme.brand.marginRightMm);
  const marginBottom = mm(theme.brand.marginBottomMm);
  for (let i = 0; i < range.count; i++) {
    const pageIndex = range.start + i;
    doc.switchToPage(pageIndex);
    const width = 150;
    const x = doc.page.width - marginRight - width;
    const y = doc.page.height - marginBottom + mm(2);
    doc.save();
    doc.fontSize(8).fillColor("#666666");
    doc.text(`Seite ${i + 1} von ${range.count}`, x, y, { width, align: "right" });
    doc.restore();
  }
}
