/** Layout "Standard" — exakt das Layout von Phase 7 (Kompatibilitaet fuer Bestandsbetreiber). */
import type { PdfLayout } from "./types";
import { drawLogoAndSender, drawRecipient, drawMetaRows, drawFooterColumns } from "./shared";

export const standardLayout: PdfLayout = {
  id: "standard",
  name: "Standard",
  description: "Dunkler Tabellenkopf, Titel in Primärfarbe, dreispaltige Fußzeile.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, left, right, margins, primary } = frame;
    drawLogoAndSender(frame, input);
    const buyerY = margins.top + 60;
    drawRecipient(frame, input, buyerY);
    doc.fontSize(18).fillColor(primary).font("Helvetica").text(input.title, left, buyerY, { align: "right", width: right - left });
    const metaTop = margins.top + 90;
    drawMetaRows(frame, [{ label: input.numberLabel, value: input.number }, ...input.meta], left + 250, metaTop);
    let y = margins.top + 170;
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
    drawFooterColumns(frame, columns, y, 8, "#666666");
  },
  footerHeight: 32,
};
