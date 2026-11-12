/** Layout "Klassik" — Logo links oben, Firmenname rechts, Doppellinie unter dem Kopf, graue Fusszeile mit Linie. */
import type { PdfLayout } from "./types";
import { drawMetaRows, drawFooterColumns, drawSubject } from "./shared";
import { drawDinAddress, dinBodyTop, infoBlockX } from "./din-address";
import { LOGO_MAX_HEIGHT_MM, headerTop } from "../layout";
import { mm } from "../marks";
import { DIN5008_FORM_B } from "../din5008";

/** Einzige Quelle fuer die Fusszeilen-Schrift: Messung (footerZoneHeight) und Zeichnung muessen identisch sein. */
const FOOTER_FONT_SIZE = 7.5;

export const klassikLayout: PdfLayout = {
  id: "klassik",
  name: "Klassik",
  description: "Logo links, Firmenname rechts, Doppellinie unter dem Kopf, dezente graue Fußzeile.",
  fontDelta: 0,
  drawKopf(frame, input) {
    const { doc, theme, left, right, margins, primary, base } = frame;
    // Kopf (Logo, Firmenname, Doppellinie) endet spaetestens bei 45 mm, auch bei grossem Oberrand.
    const top = headerTop(margins.top, 16);
    if (theme.logoBuffer) doc.image(theme.logoBuffer, left, top, { fit: [mm(theme.brand.logoWidthMm), Math.min(mm(LOGO_MAX_HEIGHT_MM), mm(DIN5008_FORM_B.fieldTopMm) - top)] });
    doc.font("Helvetica-Bold").fontSize(base + 4).fillColor(primary).text(input.senderFallback.split(" · ")[0] ?? "", left, top, { width: right - left, align: "right" });
    const ruleY = top + 42;
    doc.moveTo(left, ruleY).lineTo(right, ruleY).lineWidth(1.2).strokeColor(primary).stroke();
    doc.moveTo(left, ruleY + 3).lineTo(right, ruleY + 3).lineWidth(0.4).strokeColor(primary).stroke().lineWidth(1);
    const buyerY = ruleY + 30;
    // DIN 5008 Form B: Absenderzeile in der Vermerkzone, Anschrift ab 62,7 mm (din-address.ts).
    const recipientBottom = drawDinAddress(frame, input, { maxSize: base + 1 });
    const infoX = infoBlockX();
    doc.font("Helvetica-Bold").fontSize(base + 6).fillColor("#000").text(input.title, infoX, buyerY, { width: right - infoX, align: "right" });
    const metaBottom = drawMetaRows(frame, [{ label: input.numberLabel, value: input.number }, ...input.meta], infoX, Math.max(buyerY + base + 14, doc.y + 4), base, "#333");
    let y = dinBodyTop(recipientBottom, metaBottom, 20);
    if (input.subject) y = drawSubject(frame, input.subject, y);
    if (input.intro) {
      doc.font("Helvetica").fontSize(base).fillColor("#000").text(input.intro, left, y, { width: right - left });
      y = doc.y + 10;
    }
    return y;
  },
  table: { headerFill: null, headerText: "#000", headerHeight: 18, rowRule: "#cccccc", zebra: null, boldTitle: false, textColor: "#000" },
  drawTotalsRule(frame, x, y) {
    frame.doc.moveTo(x, y).lineTo(frame.right, y).strokeColor("#000").stroke();
  },
  drawFooter(frame, columns, y) {
    frame.doc.moveTo(frame.left, y - 6).lineTo(frame.right, y - 6).lineWidth(0.4).strokeColor("#999999").stroke().lineWidth(1);
    drawFooterColumns(frame, columns, y, FOOTER_FONT_SIZE, "#555555");
  },
  footerHeight: 40,
  footerFontSize: FOOTER_FONT_SIZE,
};
