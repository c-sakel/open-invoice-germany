/**
 * Konfigurierbares Layout (Phase 16g): erzeugt aus einer `LayoutDesignConfig` ein
 * `PdfLayout`. Rein und deterministisch. Kopf nach DIN 5008 Form B (Anschriftzone ab
 * 62,7 mm, Informationsblock ab 125 mm). Die Rumpfbloecke steuert der Renderer ueber
 * `layout.blocks`.
 */
import type { LayoutDesignConfig } from "@/schemas/layout-design";
import { DIN5008_FORM_B } from "../din5008";
import { mm } from "../marks";
import type { KopfInput, LayoutFrame, PdfLayout } from "./types";
import { drawFooterColumns, drawMetaTable, drawRecipient, drawSubject } from "./shared";

const WHITE = "#ffffff";
const ZEBRA = "#f5f5f5";

const RECIPIENT_MAX_PT = 10;
const RECIPIENT_MIN_PT = 7;

/**
 * Groesste Empfaengerschrift (10 pt abwaerts, Schritte 0,5 pt), mit der die Anschriftzeilen
 * ab `top` noch im Anschriftfeld (bis 90 mm) enden — Schriften mit grosser Zeilenhoehe
 * wuerden sechs Zeilen sonst ueber die Fensterunterkante schieben.
 */
function fitRecipientSize(frame: LayoutFrame, input: KopfInput, top: number, width: number): number {
  const { doc } = frame;
  const r = input.recipient;
  const lines = [r.name, r.contactName, r.addressLine1, r.addressLine2, `${r.postalCode} ${r.city}`, r.countryLine].filter((l): l is string => Boolean(l));
  const maxHeight = mm(DIN5008_FORM_B.fieldTopMm + DIN5008_FORM_B.fieldHeightMm) - top;
  doc.font("Helvetica");
  for (let size = RECIPIENT_MAX_PT; size > RECIPIENT_MIN_PT; size -= 0.5) {
    doc.fontSize(size);
    const height = lines.reduce((sum, line) => sum + doc.heightOfString(line, { width }), 0);
    if (height <= maxHeight) return size;
  }
  return RECIPIENT_MIN_PT;
}

export function buildLayout(config: LayoutDesignConfig): PdfLayout {
  const { colors, table } = config;
  return {
    id: "design",
    name: "Design",
    description: "Konfigurierbares Layout",
    fontDelta: 0,
    blocks: [...config.blocks],
    columns: config.columns.map((c) => ({ ...c })),
    font: config.font,
    fontSizePt: config.fontSizePt,
    marginsMm: { ...config.marginsMm },
    colors: { primary: colors.primary, text: colors.text, muted: colors.muted },
    footerMode: config.footer.mode,
    footerColumnCount: config.footer.columns,
    drawKopf(frame, input) {
      const { doc, theme, left, right, margins, base } = frame;
      const headerH = mm(config.header.heightMm);
      const logoW = mm(config.logo.widthMm);
      if (theme.logoBuffer) {
        const x = config.logo.position === "left" ? left : config.logo.position === "center" ? left + (right - left - logoW) / 2 : right - logoW;
        doc.image(theme.logoBuffer, x, margins.top, { fit: [logoW, headerH], align: config.logo.position === "left" ? undefined : config.logo.position });
      }
      const zoneTop = mm(DIN5008_FORM_B.addressZoneTopMm);
      const zoneWidth = mm(DIN5008_FORM_B.fieldLeftMm + DIN5008_FORM_B.fieldWidthMm) - left;
      if (theme.options.showSenderLine) {
        const text = theme.brand.senderLine || input.senderFallback;
        doc.font("Helvetica").fontSize(7).fillColor(colors.muted);
        const lineH = doc.currentLineHeight(true);
        doc.text(text, left, zoneTop - lineH, { width: zoneWidth, height: lineH, ellipsis: true });
      }
      const recipientBottom = drawRecipient(frame, input, zoneTop, fitRecipientSize(frame, input, zoneTop, zoneWidth), zoneWidth);
      const metaBottom = drawMetaTable(
        frame,
        [{ label: input.numberLabel, value: input.number }, ...input.meta],
        mm(DIN5008_FORM_B.infoBlockLeftMm),
        mm(50),
        right - mm(DIN5008_FORM_B.infoBlockLeftMm),
        base - 1,
      );
      const titleY = Math.max(mm(97), recipientBottom + 12, metaBottom + 12);
      doc.font("Helvetica-Bold").fontSize(base + 6).fillColor(colors.primary).text(input.title, left, titleY, { width: right - left });
      let y = doc.y + 10;
      if (config.blocks.includes("subject") && input.subject) y = drawSubject(frame, input.subject, y);
      if (config.blocks.includes("intro") && input.intro) {
        doc.font("Helvetica").fontSize(base - 1).fillColor(colors.text).text(input.intro, left, y, { width: right - left });
        y = doc.y + 10;
      }
      return y;
    },
    table: {
      headerFill: table.headerFill ? colors.tableHeader : null,
      headerText: table.headerFill ? WHITE : colors.text,
      headerHeight: 18,
      rowRule: table.rules ? colors.rule : null,
      zebra: table.zebra ? ZEBRA : null,
      boldTitle: false,
      textColor: colors.text,
    },
    drawTotalsRule(frame, x, y) {
      frame.doc.moveTo(x, y).lineTo(frame.right, y).strokeColor(colors.primary).stroke();
    },
    drawFooter(frame, footerColumns, y) {
      drawFooterColumns(frame, footerColumns, y, 8, colors.muted);
    },
    footerHeight: mm(config.footer.minHeightMm),
    footerFontSize: 8,
    giroPlacement: config.blocks.includes("giro") ? "below-totals" : "bottom-right",
  };
}
