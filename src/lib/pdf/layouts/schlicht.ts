/**
 * Layout "Schlicht" — nach den Beispielbelegen des Betreibers: Logo rechts oben,
 * kleine Absenderzeile, Infoblock rechts als zweispaltige Tabelle (Nummer gross kursiv),
 * Titel fett-kursiv, Tabellenkopf nur kursiv mit Linie, fette Positionstitel, vierspaltige
 * Fusszeile in Primaerfarbe.
 */
import type { PdfLayout } from "./types";
import { drawHeaderLogo, drawMetaTable, drawFooterColumns, drawSubject } from "./shared";
import { drawDinAddress, dinBodyTop, infoBlockX } from "./din-address";

/** Einzige Quelle fuer die Fusszeilen-Schrift: Messung (footerZoneHeight) und Zeichnung muessen identisch sein. */
const FOOTER_FONT_SIZE = 7.5;

export const schlichtLayout: PdfLayout = {
  id: "schlicht",
  name: "Schlicht",
  description: "Ruhig und klar: Infoblock rechts, kursive Tabellenköpfe, fette Positionstitel, farbige vierspaltige Fußzeile.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, left, right, margins, base } = frame;
    drawHeaderLogo(frame);
    const buyerY = margins.top + 62;

    // Infoblock rechts (Breite 200, nie links von 125 mm): kleine Beschriftung, darunter die Nummer gross
    // kursiv, darunter Label/Wert-Zeilen. Beide oberen Zeilen bekommen die VOLLE
    // Blockbreite statt einer festen Haelfte — pdfkit (dieses Bundle) ignoriert
    // `lineBreak: false`, sobald `width` gesetzt ist (der Zeilenumbruch laeuft in
    // dem Fall unabhaengig davon), ein enges Halbfeld fuer lange Labels wie
    // "Lieferscheinnummer" wuerde also trotzdem zweizeilig umbrechen und mit der
    // Meta-Tabelle darunter kollidieren.
    const infoX = Math.max(right - 200, infoBlockX());
    const infoW = right - infoX;
    // DIN 5008 Form B: Absenderzeile in der Vermerkzone, Anschrift ab 62,7 mm (din-address.ts).
    const recipientBottom = drawDinAddress(frame, input, { maxSize: base + 1 });
    doc.font("Helvetica").fontSize(base - 1).fillColor("#555");
    doc.text(input.numberLabel, infoX, buyerY - 14, { width: infoW, align: "right" });
    doc.font("Helvetica-Oblique").fontSize(base + 3).fillColor("#000");
    doc.text(input.number, infoX, buyerY - 3, { width: infoW, align: "right" });
    const metaBottom = drawMetaTable(frame, input.meta, infoX, buyerY + base + 8, infoW, base - 1);

    let y = dinBodyTop(recipientBottom, metaBottom, 26);
    doc.font("Helvetica-BoldOblique").fontSize(base + 4).fillColor("#000").text(`${input.title} ${input.number}`, left, y, { width: right - left });
    y = doc.y + 12;
    if (input.subject) y = drawSubject(frame, input.subject, y);
    if (input.intro) {
      doc.font("Helvetica").fontSize(base).fillColor("#000").text(input.intro, left, y, { width: right - left });
      y = doc.y + 12;
    }
    return y;
  },
  table: { headerFill: null, headerText: "#333", headerHeight: 16, rowRule: "#dddddd", zebra: null, boldTitle: true, textColor: "#000" },
  // Fix-Welle (Abschluss-Review, Block 3 — Referenzbeleg RE-2026-0001): die Summenlinie spannt
  // jetzt die VOLLE Inhaltsbreite (`frame.left`…`frame.right`) statt nur die Summenspalten
  // (der uebergebene `x` ist `sumLabelX`, siehe invoice-pdf.ts) — Referenz zieht die Linie
  // ueber die gesamte Seitenbreite.
  drawTotalsRule(frame, _x, y) {
    frame.doc.moveTo(frame.left, y).lineTo(frame.right, y).lineWidth(0.5).strokeColor("#999999").stroke().lineWidth(1);
  },
  drawFooter(frame, columns, y) {
    drawFooterColumns(frame, columns, y, FOOTER_FONT_SIZE, frame.primary);
  },
  footerHeight: 44,
  footerFontSize: FOOTER_FONT_SIZE,
  // Fix-Welle: GiroCode links unter dem Summenblock (Referenz RE-2026-0001) statt rechts
  // oberhalb der Fusszeile.
  giroPlacement: "below-totals",
  labels: {
    colEinzel: "Einzelpreis",
    colNetto: "Gesamtpreis",
    colPosSuffix: ".",
    net: "Gesamtbetrag netto",
    taxRow: (rate) => `zzgl. Umsatzsteuer ${rate}%`,
    gross: "Gesamtbetrag brutto",
    giroCaption: "GiroCode",
  },
};
