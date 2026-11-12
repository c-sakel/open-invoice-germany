/** Layout "Standard" — exakt das Layout von Phase 7 (Kompatibilitaet fuer Bestandsbetreiber). */
import type { PdfLayout } from "./types";
import { drawHeaderLogo, drawMetaRows, drawFooterColumns, drawSubject } from "./shared";
import { drawDinAddress, dinBodyTop, infoBlockX } from "./din-address";

/** Einzige Quelle fuer die Fusszeilen-Schrift: Messung (footerZoneHeight) und Zeichnung muessen identisch sein. */
const FOOTER_FONT_SIZE = 8;

export const standardLayout: PdfLayout = {
  id: "standard",
  name: "Standard",
  description: "Dunkler Tabellenkopf, Titel in Primärfarbe, dreispaltige Fußzeile.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, left, right, margins, primary } = frame;
    drawHeaderLogo(frame);
    const buyerY = margins.top + 60;
    // DIN 5008 Form B: Absenderzeile in der Vermerkzone, Anschrift ab 62,7 mm (din-address.ts).
    const recipientBottom = drawDinAddress(frame, input, { maxSize: 11 });
    const infoX = infoBlockX();
    doc.fontSize(18).fillColor(primary).font("Helvetica").text(input.title, infoX, buyerY, { align: "right", width: right - infoX });
    const metaTop = Math.max(margins.top + 90, doc.y + 6);
    const metaBottom = drawMetaRows(frame, [{ label: input.numberLabel, value: input.number }, ...input.meta], infoX, metaTop);
    // Der Tabellenbeginn haengt vom gedruckten Anschrift-/Meta-Block ab, frueheste Lage 97 mm.
    let y = dinBodyTop(recipientBottom, metaBottom, 20);
    if (input.subject) y = drawSubject(frame, input.subject, y);
    if (input.intro) {
      doc.fontSize(9).fillColor("#333").text(input.intro, left, y, { width: right - left });
      y = doc.y + 10;
    }
    return y;
  },
  table: { headerFill: "#1f2937", headerText: "#fff", headerHeight: 18, rowRule: null, zebra: null, boldTitle: false, textColor: "#000" },
  drawTotalsRule(frame, x, y) {
    frame.doc.moveTo(x, y).lineTo(frame.right, y).strokeColor(frame.primary).stroke();
  },
  drawFooter(frame, columns, y) {
    // Phase 7: drei Spalten (links/mitte/rechts) — bei AUTO-Fusszeile werden vier Spalten
    // gleichmaessig verteilt; Text grau 8pt wie bisher.
    drawFooterColumns(frame, columns, y, FOOTER_FONT_SIZE, "#666666");
  },
  // Phase 11b, Task 3 — vorher 32pt (reichte fuer die zweizeilige Phase-7-Fusszeile).
  // Die vierspaltige AUTO-Fusszeile traegt bis zu drei Zeilen JE Spalte bei einer bei
  // vier Spalten entsprechend schmaleren Spaltenbreite; einzelne Zeilen (z. B. die
  // gruppierte IBAN oder eine laengere E-Mail-Adresse) brechen dadurch innerhalb der
  // Spalte um. 46pt bietet Reserve fuer eine umgebrochene Zeile, ohne dass pdfkit den
  // eigenen (durch dieselben `margins.bottom` gesetzten) Seitenumbruch-Schwellenwert
  // ueberschreitet — sonst haengt eine ueberlaufende Fusszeile eine leere Folgeseite an.
  footerHeight: 46,
  footerFontSize: FOOTER_FONT_SIZE,
};
