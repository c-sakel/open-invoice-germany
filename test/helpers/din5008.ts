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
}

interface TextOptions {
  width?: number;
  height?: number;
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
    const measured = doc.heightOfString(String(text), options.width === undefined ? {} : { width: options.width });
    boxes.push({ text: String(text), xPt: x, yPt: y, widthPt, heightPt: options.height ?? measured });
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

  return {
    stop() {
      doc.text = originalText as typeof doc.text;
      doc.image = originalImage as typeof doc.image;
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
