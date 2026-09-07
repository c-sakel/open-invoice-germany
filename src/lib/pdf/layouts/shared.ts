/**
 * Layout-Bausteine (Phase 11b), die mehrere PdfLayouts teilen: Empfaengerblock,
 * rechtsbuendige/-zweispaltige Meta-Zeilen, Tabellenkopfzeile, Fusszeilen-Spalten,
 * Logo+Absenderzeile. Reine Zeichenfunktionen auf einem `LayoutFrame` — kein
 * Layout-spezifisches Wissen (das liefert `layout.table`/`layout.footerHeight`).
 */
import type { LayoutFrame, KopfInput, FooterColumn, PdfLayout } from "./types";
import { drawLogo, drawSenderLine } from "../layout";

/** Empfaengerblock (DIN-5008-Fenster); liefert Unterkante. */
export function drawRecipient(frame: LayoutFrame, input: KopfInput, y: number, size = 11): number {
  const { doc, left } = frame;
  const r = input.recipient;
  doc.fillColor("#000").font("Helvetica").fontSize(size);
  doc.text(r.name, left, y);
  if (r.contactName) doc.text(r.contactName);
  doc.text(r.addressLine1);
  if (r.addressLine2) doc.text(r.addressLine2);
  doc.text(`${r.postalCode} ${r.city}`);
  if (input.extraRecipientBlock) {
    doc.fontSize(size - 2).fillColor("#555").text(input.extraRecipientBlock.heading, left, doc.y + 8);
    doc.fontSize(size).fillColor("#000");
    for (const l of input.extraRecipientBlock.lines) doc.text(l);
  }
  return doc.y;
}

/** Rechtsbuendige Meta-Zeilen "Label: Wert" ab (x, y); liefert Unterkante. */
export function drawMetaRows(frame: LayoutFrame, rows: { label: string; value: string }[], x: number, y: number, size = 10, color = "#333"): number {
  const { doc, right } = frame;
  doc.font("Helvetica").fontSize(size).fillColor(color);
  let first = true;
  for (const row of rows) {
    if (first) {
      doc.text(`${row.label}: ${row.value}`, x, y, { width: right - x, align: "right" });
      first = false;
    } else {
      doc.text(`${row.label}: ${row.value}`, { width: right - x, align: "right" });
    }
  }
  return doc.y;
}

/** Zweispaltige Meta-Tabelle (Label links grau, Wert rechts) fuer sevDesk-artige Infobloecke; liefert Unterkante. */
export function drawMetaTable(frame: LayoutFrame, rows: { label: string; value: string }[], x: number, y: number, width: number, size = 9): number {
  const { doc } = frame;
  let cy = y;
  for (const row of rows) {
    doc.font("Helvetica").fontSize(size).fillColor("#555").text(row.label, x, cy, { width: width / 2, lineBreak: false });
    doc.fillColor("#000").text(row.value, x + width / 2, cy, { width: width / 2, align: "right", lineBreak: false });
    cy += size + 4;
  }
  return cy;
}

export interface TableHeaderColumn {
  header: string;
  /** Absolute x-Position (bereits inkl. `tableX`-Offset des Aufrufers). */
  x: number;
  width: number;
  align?: "left" | "right";
  /** Beschreibungsspalte: Text entfaellt ohne `showDescription`, die Spaltenbreite bleibt
   *  trotzdem reserviert (Phase 7 — Rechnungs-Tabelle rueckt sonst zusammen). */
  isDescription?: boolean;
}

/**
 * Zeichnet die Tabellenkopfzeile nach `layout.table` (dunkler Balken bei `headerFill`,
 * sonst eine Linie) und liefert die y-Koordinate, an der die erste Datenzeile beginnt.
 * Von `invoice-pdf.ts` und `delivery-note-pdf.ts` gemeinsam genutzt (Phase 11b, Task 3
 * — vorher zwei fast identische Kopien).
 */
export function drawTableHeaderRow(frame: LayoutFrame, layout: PdfLayout, columns: TableHeaderColumn[], atY: number, showDescription: boolean): number {
  const { doc, left, right, base } = frame;
  const t = layout.table;
  doc.fontSize(base - 1);
  if (t.headerFill) {
    doc.rect(left, atY, right - left, t.headerHeight).fill(t.headerFill);
  } else {
    doc.moveTo(left, atY + t.headerHeight).lineTo(right, atY + t.headerHeight).strokeColor(t.rowRule ?? "#999").stroke();
  }
  doc.fillColor(t.headerText).font(t.headerFill ? "Helvetica" : "Helvetica-Oblique");
  for (const col of columns) {
    if (col.isDescription && !showDescription) continue;
    doc.text(col.header, col.x, atY + (t.headerFill ? 5 : 3), { width: col.width, align: col.align ?? "left" });
  }
  doc.font("Helvetica").fillColor(t.textColor).fontSize(base - 1);
  return atY + t.headerHeight + 4;
}

/** Fusszeilen-Spalten gleichmaessig ueber die Breite; liefert nichts. */
export function drawFooterColumns(frame: LayoutFrame, columns: FooterColumn[], y: number, size = 7.5, color = "#666666"): void {
  const { doc, left, width } = frame;
  const visible = columns.filter((c) => c.lines.length > 0);
  if (visible.length === 0) return;
  const gap = 10;
  const colWidth = (width - gap * (visible.length - 1)) / visible.length;
  doc.font("Helvetica").fontSize(size).fillColor(color);
  visible.forEach((col, i) => {
    doc.text(col.lines.join("\n"), left + i * (colWidth + gap), y, { width: colWidth, lineGap: 1 });
  });
}

export function drawLogoAndSender(frame: LayoutFrame, input: KopfInput): void {
  const { doc, theme, right, left, margins } = frame;
  drawLogo(doc, theme, right, margins.top);
  drawSenderLine(doc, theme, left, margins.top, input.senderFallback);
}
