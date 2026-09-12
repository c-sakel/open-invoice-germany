/**
 * Liberation-Sans-Schriften fuer den PDF/A-3b-Modus (Task 6, Spec R10).
 *
 * Liberation Sans ist metrisch kompatibel zu Arial/Helvetica (SIL Open Font License 1.1,
 * siehe `assets/fonts/LICENSE-OFL.txt`; Herkunft und Nachweis der Glyphenabdeckung in
 * `docs/ARCHITEKTUR.md`). `registerPdfFonts` registriert die vier Schnitte unter den
 * **bestehenden** pdfkit-Standardnamen — keiner der zahlreichen `doc.font("Helvetica"...)`-
 * Aufrufe im Bestand muss angefasst werden.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

interface LiberationSansBuffers {
  regular: Buffer;
  bold: Buffer;
  italic: Buffer;
  boldItalic: Buffer;
}

let cached: LiberationSansBuffers | null = null;

/** Liest die vier TTF-Dateien einmalig von der Platte und cached sie als Buffer. */
function loadFontBuffers(): LiberationSansBuffers {
  if (cached) return cached;
  const dir = path.join(process.cwd(), "assets/fonts");
  cached = {
    regular: readFileSync(path.join(dir, "LiberationSans-Regular.ttf")),
    bold: readFileSync(path.join(dir, "LiberationSans-Bold.ttf")),
    italic: readFileSync(path.join(dir, "LiberationSans-Italic.ttf")),
    boldItalic: readFileSync(path.join(dir, "LiberationSans-BoldItalic.ttf")),
  };
  return cached;
}

/**
 * Registriert Liberation Sans unter den vier Helvetica-Namen, die im gesamten
 * PDF-Renderer-Bestand verwendet werden. Muss nach `new PDFDocument({ font: null, ... })`
 * und vor dem ersten `doc.font(...)`-Aufruf laufen.
 */
export function registerPdfFonts(doc: PDFKit.PDFDocument): void {
  const fonts = loadFontBuffers();
  doc.registerFont("Helvetica", fonts.regular);
  doc.registerFont("Helvetica-Bold", fonts.bold);
  doc.registerFont("Helvetica-Oblique", fonts.italic);
  doc.registerFont("Helvetica-BoldOblique", fonts.boldItalic);
}
