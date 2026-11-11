/**
 * Schriften fuer den PDF/A-3b-Modus (Task 6, Spec R10; Familienwahl Phase 16g).
 *
 * Liberation Sans ist metrisch kompatibel zu Arial/Helvetica (SIL Open Font License 1.1,
 * siehe `assets/fonts/LICENSE-OFL.txt`; Herkunft und Nachweis der Glyphenabdeckung in
 * `docs/ARCHITEKTUR.md`). `registerPdfFonts` registriert die vier Schnitte unter den
 * **bestehenden** pdfkit-Standardnamen — keiner der zahlreichen `doc.font("Helvetica"...)`-
 * Aufrufe im Bestand muss angefasst werden. Weitere Familien (IBM Plex, Source Serif 4, Inter;
 * Nachweis in `assets/fonts/README.md`) nutzen dieselben vier Namen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PDF_FONT_FAMILY, type PdfFontFamily } from "./font-families";

interface PdfFontFiles {
  regular: string;
  bold: string;
  italic: string;
  boldItalic: string;
}

export interface PdfFontBuffers {
  regular: Buffer;
  bold: Buffer;
  italic: Buffer;
  boldItalic: Buffer;
}

export const PDF_FONT_FILES: Record<PdfFontFamily, PdfFontFiles> = {
  "liberation-sans": {
    regular: "LiberationSans-Regular.ttf",
    bold: "LiberationSans-Bold.ttf",
    italic: "LiberationSans-Italic.ttf",
    boldItalic: "LiberationSans-BoldItalic.ttf",
  },
  "ibm-plex-sans": {
    regular: "IBMPlexSans-Regular.ttf",
    bold: "IBMPlexSans-Bold.ttf",
    italic: "IBMPlexSans-Italic.ttf",
    boldItalic: "IBMPlexSans-BoldItalic.ttf",
  },
  "ibm-plex-serif": {
    regular: "IBMPlexSerif-Regular.ttf",
    bold: "IBMPlexSerif-Bold.ttf",
    italic: "IBMPlexSerif-Italic.ttf",
    boldItalic: "IBMPlexSerif-BoldItalic.ttf",
  },
  "source-serif-4": {
    regular: "SourceSerif4-Regular.ttf",
    bold: "SourceSerif4-Bold.ttf",
    italic: "SourceSerif4-It.ttf",
    boldItalic: "SourceSerif4-BoldIt.ttf",
  },
  inter: {
    regular: "Inter-Regular.ttf",
    bold: "Inter-Bold.ttf",
    italic: "Inter-Italic.ttf",
    boldItalic: "Inter-BoldItalic.ttf",
  },
};

const cache = new Map<PdfFontFamily, PdfFontBuffers>();

/** Liest die vier TTF-Dateien einer Familie einmalig von der Platte und cached sie als Buffer. */
export function loadFontBuffers(family: PdfFontFamily): PdfFontBuffers {
  const hit = cache.get(family);
  if (hit) return hit;
  const dir = path.join(process.cwd(), "assets/fonts");
  const files = PDF_FONT_FILES[family];
  const buffers: PdfFontBuffers = {
    regular: readFileSync(path.join(dir, files.regular)),
    bold: readFileSync(path.join(dir, files.bold)),
    italic: readFileSync(path.join(dir, files.italic)),
    boldItalic: readFileSync(path.join(dir, files.boldItalic)),
  };
  cache.set(family, buffers);
  return buffers;
}

/**
 * Registriert die Familie unter den vier Helvetica-Namen, die im gesamten
 * PDF-Renderer-Bestand verwendet werden. Muss nach `new PDFDocument({ font: null, ... })`
 * und vor dem ersten `doc.font(...)`-Aufruf laufen.
 */
export function registerPdfFonts(doc: PDFKit.PDFDocument, family: PdfFontFamily = DEFAULT_PDF_FONT_FAMILY): void {
  const fonts = loadFontBuffers(family);
  doc.registerFont("Helvetica", fonts.regular);
  doc.registerFont("Helvetica-Bold", fonts.bold);
  doc.registerFont("Helvetica-Oblique", fonts.italic);
  doc.registerFont("Helvetica-BoldOblique", fonts.boldItalic);
}
