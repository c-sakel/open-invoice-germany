/**
 * Phase 16g, Task 1 — einbettbare PDF-Schriftfamilien (Glyphenabdeckung, Einbettung, Nachweis).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import { PDF_FONT_FAMILIES, PDF_FONT_LABELS, DEFAULT_PDF_FONT_FAMILY, type PdfFontFamily } from "@/lib/pdf/font-families";
import { PDF_FONT_FILES, loadFontBuffers } from "@/lib/pdf/fonts";
import { createPdfDocument } from "@/lib/pdf/document";

const FONT_DIR = path.join(process.cwd(), "assets/fonts");
const SAMPLE = "ÄÖÜäöüß€„“‚‘»«–—…·§°×²³½";
const CODEPOINTS = [
  ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i),
  ...Array.from(SAMPLE).map((c) => c.codePointAt(0) as number),
];
const POSTSCRIPT: Record<PdfFontFamily, string> = {
  "liberation-sans": "LiberationSans",
  "ibm-plex-sans": "IBMPlexSans",
  "ibm-plex-serif": "IBMPlexSerif",
  "source-serif-4": "SourceSerif4",
  inter: "Inter",
};
const NEW_FAMILIES = PDF_FONT_FAMILIES.filter((f) => f !== DEFAULT_PDF_FONT_FAMILY);

function renderSample(fontFamily?: PdfFontFamily): Promise<string> {
  const doc = createPdfDocument({
    size: "A4",
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    compress: false,
    pdfa: true,
    fontFamily,
  });
  const chunks: Buffer[] = [];
  const done = new Promise<string>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
    doc.on("error", reject);
  });
  doc.on("data", (c: Buffer) => chunks.push(c));
  doc.font("Helvetica").text("€ „Prüfung“");
  doc.font("Helvetica-Bold").text("€ „Prüfung“");
  doc.end();
  return done;
}

describe("PDF-Schriftfamilien", () => {
  it("Labels und Default", () => {
    expect(DEFAULT_PDF_FONT_FAMILY).toBe("liberation-sans");
    expect(PDF_FONT_LABELS["liberation-sans"]).toBe("Liberation Sans (Standard)");
    expect(Object.keys(PDF_FONT_LABELS).sort()).toEqual([...PDF_FONT_FAMILIES].sort());
  });

  for (const family of PDF_FONT_FAMILIES) {
    for (const [cut, file] of Object.entries(PDF_FONT_FILES[family])) {
      it(`${family}/${cut}: deckt ASCII und deutsche Typografie ab`, () => {
        const font = fontkit.create(readFileSync(path.join(FONT_DIR, file)));
        const missing = CODEPOINTS.filter((cp) => !font.hasGlyphForCodePoint(cp)).map((cp) => String.fromCodePoint(cp));
        expect(missing).toEqual([]);
      });
    }
  }

  for (const family of PDF_FONT_FAMILIES) {
    it(`${family}: wird in PDF/A-Dokument eingebettet`, async () => {
      const pdf = await renderSample(family === DEFAULT_PDF_FONT_FAMILY ? undefined : family);
      expect(pdf).toContain("/FontFile2");
      expect(pdf).toMatch(new RegExp(`/BaseFont /[A-Z]{6}\\+${POSTSCRIPT[family]}`));
    });
  }

  it("loadFontBuffers cached je Familie", () => {
    expect(loadFontBuffers("inter")).toBe(loadFontBuffers("inter"));
    expect(loadFontBuffers("inter")).not.toBe(loadFontBuffers("ibm-plex-sans"));
  });

  it("README nennt alle 16 neuen Dateien mit passendem SHA-256", () => {
    const readme = readFileSync(path.join(FONT_DIR, "README.md"), "utf8");
    let count = 0;
    for (const family of NEW_FAMILIES) {
      for (const file of Object.values(PDF_FONT_FILES[family])) {
        const hash = createHash("sha256").update(readFileSync(path.join(FONT_DIR, file))).digest("hex");
        const row = readme.split("\n").find((l) => l.includes(`\`${file}\``));
        expect(row, file).toBeDefined();
        expect(row, file).toContain(hash);
        count++;
      }
    }
    expect(count).toBe(16);
  });

  it("Lizenzdateien je Familie vorhanden", () => {
    for (const f of ["LICENSE-OFL-IBM-Plex.txt", "LICENSE-OFL-Source-Serif-4.txt", "LICENSE-OFL-Inter.txt"]) {
      expect(readFileSync(path.join(FONT_DIR, f), "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });
});
