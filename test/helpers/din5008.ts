/**
 * Test-Hilfe (Phase 16g): zeichnet Textboxen und Bilder eines pdfkit-Dokuments auf und prueft
 * sie gegen das DIN-5008-Anschriftfeld. Fuer 16d (Postversand) wiederverwendbar.
 */
import { expect } from "vitest";
import { dinWindowViolations } from "@/lib/pdf/din5008";

const PT_TO_MM = 25.4 / 72;

export interface RecordedBox {
  text: string;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  /** Nur Text: tatsaechliche Textbreite (einzeilig, aktuelle Schrift) und Ausrichtung. */
  textWidthPt?: number;
  /** Nur Text: Schriftgroesse beim Zeichnen. */
  fontSizePt?: number;
  align?: "left" | "right" | "center" | "justify";
}

interface TextOptions {
  width?: number;
  height?: number;
  lineGap?: number;
  align?: "left" | "right" | "center" | "justify";
}

/** Spy auf `doc.text`/`doc.image`; `stop()` stellt die Originale wieder her und liefert die Boxen. */
export function recordTextBoxes(doc: PDFKit.PDFDocument): { stop(): RecordedBox[] } {
  const boxes: RecordedBox[] = [];
  const originalText = doc.text.bind(doc);
  const originalImage = doc.image.bind(doc);
  const docState = doc as unknown as { x: number; y: number };

  doc.text = ((text: string, a?: number | TextOptions, b?: number | TextOptions, c?: TextOptions) => {
    const x = typeof a === "number" ? a : docState.x;
    const y = typeof a === "number" && typeof b === "number" ? b : docState.y;
    const options: TextOptions = (typeof a === "object" ? a : typeof b === "object" ? b : c) ?? {};
    const widthPt = options.width ?? doc.widthOfString(String(text));
    const measureOptions: TextOptions = {};
    if (options.width !== undefined) measureOptions.width = options.width;
    if (options.lineGap !== undefined) measureOptions.lineGap = options.lineGap;
    const measured = doc.heightOfString(String(text), measureOptions);
    boxes.push({ text: String(text), xPt: x, yPt: y, widthPt, heightPt: options.height ?? measured, fontSizePt: (doc as unknown as { _fontSize: number })._fontSize, textWidthPt: Math.min(widthPt, doc.widthOfString(String(text))), ...(options.align ? { align: options.align } : {}) });
    return originalText(text, a as number, b as number, c);
  }) as typeof doc.text;

  doc.image = ((src: Buffer | string, a?: number | PDFKit.Mixins.ImageOption, b?: number, c?: PDFKit.Mixins.ImageOption) => {
    const x = typeof a === "number" ? a : 0;
    const y = typeof b === "number" ? b : 0;
    const options = (typeof a === "object" ? a : c) ?? {};
    const natural = (doc as unknown as { openImage(s: Buffer | string): { width: number; height: number } }).openImage(src);
    let widthPt = options.width ?? natural.width;
    let heightPt = options.height ?? natural.height;
    if (options.fit) {
      const scale = Math.min(options.fit[0] / natural.width, options.fit[1] / natural.height);
      widthPt = natural.width * scale;
      heightPt = natural.height * scale;
    }
    boxes.push({ text: "[image]", xPt: x, yPt: y, widthPt, heightPt });
    return originalImage(src as string, a as number, b as number, c);
  }) as typeof doc.image;

  // Flaechen und Linien (Kopfbalken, Karten, Trennlinien) als "[rect]" bzw. "[line]".
  const originalRect = doc.rect.bind(doc);
  const originalRounded = doc.roundedRect.bind(doc);
  const originalMoveTo = doc.moveTo.bind(doc);
  const originalLineTo = doc.lineTo.bind(doc);
  let pen = { x: 0, y: 0 };
  let inShape = false; // rect/roundedRect rufen intern moveTo/lineTo auf
  doc.rect = ((x: number, y: number, w: number, h: number) => {
    boxes.push({ text: "[rect]", xPt: x, yPt: y, widthPt: w, heightPt: h });
    inShape = true;
    try {
      return originalRect(x, y, w, h);
    } finally {
      inShape = false;
    }
  }) as typeof doc.rect;
  doc.roundedRect = ((x: number, y: number, w: number, h: number, r?: number) => {
    boxes.push({ text: "[rect]", xPt: x, yPt: y, widthPt: w, heightPt: h });
    inShape = true;
    try {
      return originalRounded(x, y, w, h, r);
    } finally {
      inShape = false;
    }
  }) as typeof doc.roundedRect;
  doc.moveTo = ((x: number, y: number) => {
    pen = { x, y };
    return originalMoveTo(x, y);
  }) as typeof doc.moveTo;
  doc.lineTo = ((x: number, y: number) => {
    if (!inShape) boxes.push({ text: "[line]", xPt: Math.min(pen.x, x), yPt: Math.min(pen.y, y), widthPt: Math.abs(x - pen.x), heightPt: Math.abs(y - pen.y) });
    pen = { x, y };
    return originalLineTo(x, y);
  }) as typeof doc.lineTo;

  return {
    stop() {
      doc.text = originalText as typeof doc.text;
      doc.image = originalImage as typeof doc.image;
      doc.rect = originalRect as typeof doc.rect;
      doc.roundedRect = originalRounded as typeof doc.roundedRect;
      doc.moveTo = originalMoveTo as typeof doc.moveTo;
      doc.lineTo = originalLineTo as typeof doc.lineTo;
      return boxes;
    },
  };
}

/** Jeder Text muss als Box vorkommen und vollstaendig im Anschriftfeld liegen. */
export function expectInDinWindow(boxes: RecordedBox[], texts: string[]): void {
  for (const text of texts) {
    const box = boxes.find((b) => b.text === text);
    expect(box, `Text nicht gezeichnet: ${text}`).toBeDefined();
    if (!box) continue;
    const violations = dinWindowViolations({
      xMm: box.xPt * PT_TO_MM,
      yMm: box.yPt * PT_TO_MM,
      widthMm: box.widthPt * PT_TO_MM,
      heightMm: box.heightPt * PT_TO_MM,
    });
    expect(violations, `${text}: ${violations.join(" ")}`).toEqual([]);
  }
}
