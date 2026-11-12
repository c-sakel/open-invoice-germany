/**
 * Konfigurierbares Layout (Phase 16g): erzeugt aus einer `LayoutDesignConfig` ein
 * `PdfLayout`. Rein und deterministisch. Kopf nach DIN 5008 Form B (Anschriftzone ab
 * 62,7 mm, Informationsblock ab 125 mm). Die Rumpfbloecke steuert der Renderer ueber
 * `layout.blocks`.
 */
import type { LayoutDesignConfig } from "@/schemas/layout-design";
import { DIN5008_FORM_B } from "../din5008";
import { mm } from "../marks";
import { createPdfDocument } from "../document";
import { marginsFromMm } from "../layout";
import type { KopfInput, PdfLayout } from "./types";
import { drawFooterColumns, drawMetaTable, drawRecipient, drawSubject } from "./shared";

const WHITE = "#ffffff";
const ZEBRA = "#f5f5f5";

const RECIPIENT_MAX_PT = 10;
const RECIPIENT_MIN_PT = 8;
/** Kleinster Zeilenabstand-Zuschlag (pt), wenn auch 8 pt nicht passen. */
const RECIPIENT_MIN_LINE_GAP = -2;

export interface RecipientFit {
  size: number;
  /** Nur gesetzt, wenn der Zeilenabstand verringert werden musste. */
  lineGap?: number;
}

function recipientLines(input: KopfInput): string[] {
  const r = input.recipient;
  return [r.name, r.contactName, r.addressLine1, r.addressLine2, `${r.postalCode} ${r.city}`, r.countryLine].filter((l): l is string => Boolean(l));
}

/** Hoehe des Empfaengerblocks inkl. Zusatzblock, gemessen wie `drawRecipient` ihn zeichnet. */
function recipientHeight(doc: PDFKit.PDFDocument, input: KopfInput, size: number, width: number, lineGap: number | undefined): number {
  const opts = lineGap === undefined ? { width } : { width, lineGap };
  doc.font("Helvetica").fontSize(size);
  let height = recipientLines(input).reduce((sum, line) => sum + doc.heightOfString(line, opts), 0);
  const extra = input.extraRecipientBlock;
  if (extra) {
    doc.fontSize(size - 2);
    height += 8 + doc.heightOfString(extra.heading, opts);
    doc.fontSize(size);
    height += extra.lines.reduce((sum, line) => sum + doc.heightOfString(line, opts), 0);
  }
  return height;
}

/**
 * Groesste Empfaengerschrift (10 pt abwaerts bis 8 pt, Schritte 0,5 pt), mit der Anschrift und
 * Zusatzblock ab `top` noch im Anschriftfeld (bis 90 mm) enden. Passt es bei 8 pt nicht, wird
 * der Zeilenabstand stufenweise verringert; ohne Erfolg Rueckfall auf 8 pt mit dem Mindestabstand.
 * Wirft nie. `fits` meldet, ob das Fenster tatsaechlich eingehalten wird.
 */
export function fitRecipient(doc: PDFKit.PDFDocument, input: KopfInput, top: number, width: number): RecipientFit & { fits: boolean } {
  const maxHeight = mm(DIN5008_FORM_B.fieldTopMm + DIN5008_FORM_B.fieldHeightMm) - top;
  for (let size = RECIPIENT_MAX_PT; size >= RECIPIENT_MIN_PT; size -= 0.5) {
    if (recipientHeight(doc, input, size, width, undefined) <= maxHeight) return { size, fits: true };
  }
  for (let gap = -0.5; gap >= RECIPIENT_MIN_LINE_GAP; gap -= 0.5) {
    if (recipientHeight(doc, input, RECIPIENT_MIN_PT, width, gap) <= maxHeight) return { size: RECIPIENT_MIN_PT, lineGap: gap, fits: true };
  }
  return { size: RECIPIENT_MIN_PT, lineGap: RECIPIENT_MIN_LINE_GAP, fits: false };
}

const WORST_CASE_INPUT: KopfInput = {
  title: "",
  numberLabel: "",
  number: "",
  meta: [],
  senderFallback: "",
  recipient: {
    name: "Beispiel Automotive GmbH",
    contactName: "Frau Erika Musterfrau",
    addressLine1: "Kundenstraße 13",
    addressLine2: "Hinterhaus, 3. Etage",
    postalCode: "12345",
    city: "Musterstadt",
    countryLine: "ÖSTERREICH",
  },
  extraRecipientBlock: { heading: "Lieferanschrift", lines: ["Lager Nord, Hafenstraße 1"] },
};

/**
 * Prueft zur Speicherzeit, ob die Anschrift im DIN-5008-Fenster bleibt: sechs Anschriftzeilen
 * plus Lieferanschrift-Zusatzblock mit der gewaehlten Schrift. `null` = passt, sonst Fehlertext.
 */
export function checkRecipientWindow(config: LayoutDesignConfig): string | null {
  const margins = marginsFromMm(config.marginsMm);
  const doc = createPdfDocument({ size: "A4", margins, compress: false, pdfa: true, fontFamily: config.font });
  const zoneTop = mm(DIN5008_FORM_B.addressZoneTopMm);
  const zoneWidth = mm(DIN5008_FORM_B.fieldLeftMm + DIN5008_FORM_B.fieldWidthMm) - margins.left;
  const fit = fitRecipient(doc, WORST_CASE_INPUT, zoneTop, zoneWidth);
  doc.end();
  if (fit.fits) return null;
  return `Mit der Schrift „${config.font}“ passt eine sechszeilige Anschrift mit Lieferanschrift nicht in das Anschriftfeld (bis 90 mm). Wählen Sie eine andere Schrift.`;
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
      const fit = fitRecipient(doc, input, zoneTop, zoneWidth);
      const recipientBottom = drawRecipient(frame, input, zoneTop, fit.size, zoneWidth, fit.lineGap);
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
      // Betreff und Einleitung: vorhandener Inhalt wird immer gedruckt (PDF = XML-Inhalt);
      // `blocks` bestimmt nur die Reihenfolge der Rumpfbloecke, nicht ob Text entfaellt.
      if (input.subject) y = drawSubject(frame, input.subject, y);
      if (input.intro) {
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
