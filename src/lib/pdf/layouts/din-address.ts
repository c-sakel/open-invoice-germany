/**
 * Anschriftfeld nach DIN 5008 Form B (geteilt von festen Layouts und Layout-Designs):
 * Absenderzeile (Rueckseendeangabe) als unterste Zeile der Zusatz-/Vermerkzone direkt ueber der
 * Anschriftzone, Empfaengeranschrift ab 62,7 mm. Eine Implementierung fuer beide Pfade.
 */
import { DIN5008_FORM_B } from "../din5008";
import { mm } from "../marks";
import type { KopfInput, LayoutFrame } from "./types";
import { drawRecipient } from "./shared";
import { wrapPlain } from "../text-wrap";

/** Hoechste/kleinste Schrift der Absenderzeile (pt); dazwischen in 0,5-pt-Schritten. Nie unter 6 pt. */
const SENDER_MAX_PT = 7;
const SENDER_MIN_PT = 6;

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
 * Groesste Empfaengerschrift (`maxSize`, Standard 10 pt, abwaerts bis 8 pt, Schritte 0,5 pt), mit der Anschrift und
 * Zusatzblock ab `top` noch im Anschriftfeld (bis 90 mm) enden. Passt es bei 8 pt nicht, wird
 * der Zeilenabstand stufenweise verringert; ohne Erfolg Rueckfall auf 8 pt mit dem Mindestabstand.
 * Wirft nie. `fits` meldet, ob das Fenster tatsaechlich eingehalten wird.
 */
export function fitRecipient(doc: PDFKit.PDFDocument, input: KopfInput, top: number, width: number, maxSize: number = RECIPIENT_MAX_PT): RecipientFit & { fits: boolean } {
  const maxHeight = mm(DIN5008_FORM_B.fieldTopMm + DIN5008_FORM_B.fieldHeightMm) - top;
  for (let size = maxSize; size >= RECIPIENT_MIN_PT; size -= 0.5) {
    if (recipientHeight(doc, input, size, width, undefined) <= maxHeight) return { size, fits: true };
  }
  for (let gap = -0.5; gap >= RECIPIENT_MIN_LINE_GAP; gap -= 0.5) {
    if (recipientHeight(doc, input, RECIPIENT_MIN_PT, width, gap) <= maxHeight) return { size: RECIPIENT_MIN_PT, lineGap: gap, fits: true };
  }
  return { size: RECIPIENT_MIN_PT, lineGap: RECIPIENT_MIN_LINE_GAP, fits: false };
}


export interface DinAddressOptions {
  /** Linke Kante der Anschrift (pt); Standard 20 mm bzw. der linke Rand, falls groesser. */
  x?: number;
  /** Breite (pt); Standard bis zur rechten Feldkante (105 mm). */
  width?: number;
  /** Bevorzugte Anschriftschrift (pt), von `fitRecipient` ggf. verkleinert. */
  maxSize?: number;
  senderColor?: string;
}

/**
 * Umbruch der Absenderzeile bevorzugt an " · " (das Trennzeichen bleibt am Zeilenende); einzelne
 * Teile, die allein nicht passen, werden an Woertern umbrochen.
 */
function wrapSenderLine(doc: PDFKit.PDFDocument, text: string, width: number, size: number): string[] {
  const parts = text.split(" · ").map((p, i, all) => (i < all.length - 1 ? `${p} ·` : p));
  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    const candidate = current ? `${current} ${part}` : part;
    if (doc.widthOfString(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (doc.widthOfString(part) <= width) {
      current = part;
    } else {
      const pieces = wrapPlain(doc, part, width, "Helvetica", size);
      current = pieces.pop() ?? "";
      lines.push(...pieces);
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Absenderzeile in der Vermerkzone: Unterkante = Anschriftzone (62,7 mm). 7 pt, bei Ueberlaenge
 * stufenweise bis 6 pt; passt sie dann nicht in 85 mm, Umbruch (bevorzugt an " · ") innerhalb der
 * Zone von 45 bis 62,7 mm, unterste Zeile direkt ueber der Anschrift. Zeichnet nichts bei
 * ausgeschaltetem `showSenderLine`.
 */
export function drawDinSenderLine(frame: LayoutFrame, input: KopfInput, x: number, width: number, color: string): void {
  const { doc, theme } = frame;
  if (!theme.options.showSenderLine) return;
  const text = theme.brand.senderLine || input.senderFallback;
  const zoneTop = mm(DIN5008_FORM_B.fieldTopMm);
  const zoneBottom = mm(DIN5008_FORM_B.addressZoneTopMm);
  doc.font("Helvetica").fillColor(color);
  let size = SENDER_MAX_PT;
  doc.fontSize(size);
  while (size > SENDER_MIN_PT && doc.widthOfString(text) > width) {
    size -= 0.5;
    doc.fontSize(size);
  }
  const lineH = doc.currentLineHeight(true);
  const lines = doc.widthOfString(text) > width ? wrapSenderLine(doc, text, width, size) : [text];
  const maxLines = Math.max(1, Math.floor((zoneBottom - zoneTop) / lineH));
  if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length - maxLines + 1, lines.slice(maxLines - 1).join(" "));
  const top = zoneBottom - lines.length * lineH;
  lines.forEach((line, i) => doc.text(line, x, top + i * lineH, { width, height: lineH, ellipsis: true }));
}

/**
 * Absenderzeile und Empfaengeranschrift im Anschriftfeld; liefert die Unterkante der Anschrift.
 * Die Anschrift beginnt immer bei 62,7 mm.
 */
export function drawDinAddress(frame: LayoutFrame, input: KopfInput, options: DinAddressOptions = {}): number {
  const x = options.x ?? Math.max(frame.left, mm(DIN5008_FORM_B.fieldLeftMm));
  const width = options.width ?? mm(DIN5008_FORM_B.fieldLeftMm + DIN5008_FORM_B.fieldWidthMm) - x;
  const zoneTop = mm(DIN5008_FORM_B.addressZoneTopMm);
  drawDinSenderLine(frame, input, x, width, options.senderColor ?? "#555555");
  const fit = fitRecipient(frame.doc, input, zoneTop, width, options.maxSize);
  return drawRecipient({ ...frame, left: x }, input, zoneTop, fit.size, width, fit.lineGap);
}

/** Frueheste y-Position (pt) fuer Titel/Tabelle unterhalb des Anschriftfelds plus Abstand. */
export function dinBodyTop(recipientBottom: number, metaBottom: number, gap: number): number {
  return Math.max(Math.max(recipientBottom, metaBottom) + gap, mm(97));
}
