/**
 * Rendert geparste Rich-Text-Blöcke in ein pdfkit-Dokument.
 *
 * fix/pdf-umbrueche: das Modul setzt Zeilen selbst (`@/lib/pdf/text-wrap`) statt pdfkit
 * umbrechen und paginieren zu lassen:
 * - Seitenumbruch ueber den optionalen Hook `ensureSpace` VOR jeder Zeile — pdfkit kennt nur
 *   `margins.bottom`, nicht die Fusszeilen-Reserve der Layouts (lange Beschreibungen liefen
 *   in die Fusszeile). Lange Texte brechen zeilenweise auf die Folgeseite um.
 * - Aufzaehlungen ("- ", "1. " sowie im Text getippte "• "/"- "-Zeilen) haengend eingerueckt:
 *   Folgezeilen beginnen unter dem Text, nicht unter dem Aufzaehlungszeichen.
 * - Feste Abstaende: Zeile = Zeilenhoehe, Aufzaehlungspunkt zu Aufzaehlungspunkt 0,15,
 *   Absatz zu Absatz 0,5 Zeilenhoehen (auch ueber Blockgrenzen hinweg einheitlich).
 * - Umbruch nur an Leerzeichen; ein Bindestrich bleibt als Zeichen erhalten und wird nie als
 *   weicher Umbruch behandelt (siehe text-wrap.ts).
 *
 * Fett/Kursiv werden über einen Fontwechsel (Basisname + "-Bold"/"-Oblique"/
 * "-BoldOblique") abgebildet, Unterstreichung über die pdfkit-Textoption
 * `underline`. Links werden als klickbare pdfkit-Links gerendert (die
 * Zielprüfung ist bereits beim Parsen erfolgt, siehe sanitize.ts).
 */
import type { Block, Run } from "./types";
import { drawWrappedLine, wrapRuns, type StyledRun, type WrappedLine } from "../pdf/text-wrap";

export interface RenderPdfOptions {
  x: number;
  width: number;
  fontSize?: number;
  /** Basis-Fontname, z. B. "Helvetica" (Standard) oder "Times-Roman". */
  font?: string;
  /**
   * Seitenumbruch-Hook: wird vor jeder Zeile mit der aktuellen y-Position und der
   * benoetigten Hoehe gerufen und liefert die (ggf. nach einem Seitenumbruch neue)
   * y-Position. Ohne Hook wird nie umgebrochen (Text laeuft wie bisher ab `doc.y`).
   */
  ensureSpace?: (y: number, needed: number) => number;
  /** Fuellfarbe; wird nach einem Seitenumbruch (der Hook darf die Farbe veraendern) erneut gesetzt. */
  color?: string;
}

const PARAGRAPH_SPACING = 0.5;
const LIST_ITEM_SPACING = 0.15;
/** Einzug des Aufzaehlungszeichens vom linken Rand (pt). */
const MARKER_INDENT = 8;
/** Abstand zwischen Aufzaehlungszeichen und Text (pt). */
const MARKER_GAP = 3;
/** Im Text getippte Aufzaehlungszeichen am Zeilenanfang. */
const TYPED_BULLET = /^[•·▪◦*-]\s+/;

function fontNameFor(base: string, run: Run): string {
  if (run.bold && run.italic) return `${base}-BoldOblique`;
  if (run.bold) return `${base}-Bold`;
  if (run.italic) return `${base}-Oblique`;
  return base;
}

function styled(base: string, runs: Run[]): StyledRun[] {
  return runs.map((r) => ({ text: r.text, font: fontNameFor(base, r), underline: r.underline === true, href: r.href }));
}

/**
 * Zerlegt Runs eines Blocks in visuelle Zeilen anhand eingebetteter \n
 * (Zeilenumbruch innerhalb des Absatzes). Leere Segmente werden verworfen.
 */
function splitRunsIntoLines(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const run of runs) {
    const segments = run.text.split("\n");
    segments.forEach((segment, index) => {
      if (segment.length > 0) lines[lines.length - 1]!.push({ ...run, text: segment });
      if (index < segments.length - 1) lines.push([]);
    });
  }
  return lines.filter((l) => l.length > 0);
}

interface Entry {
  /** Aufzaehlungszeichen ("•", "1.") oder `null` fuer Fliesstext. */
  marker: string | null;
  /** Einrueckung des Textes (pt, relativ zu `x`). */
  textIndent: number;
  runs: Run[];
  /** Letzter Eintrag seines Blocks (Absatz bzw. Liste). */
  blockEnd: boolean;
}

function buildEntries(doc: PDFKit.PDFDocument, blocks: Block[], base: string, size: number): Entry[] {
  const entries: Entry[] = [];
  doc.font(base).fontSize(size);
  const indentFor = (markers: string[]): number => MARKER_INDENT + Math.max(...markers.map((m) => doc.widthOfString(m))) + MARKER_GAP;
  for (const block of blocks) {
    const start = entries.length;
    if (block.type === "paragraph") {
      const lines = splitRunsIntoLines(block.runs);
      const typed = lines.map((line) => TYPED_BULLET.test(line[0]!.text));
      const bulletIndent = typed.some(Boolean) ? indentFor(["•"]) : 0;
      lines.forEach((line, i) => {
        if (!typed[i]) {
          entries.push({ marker: null, textIndent: 0, runs: line, blockEnd: false });
          return;
        }
        const runs = line.map((r, idx) => (idx === 0 ? { ...r, text: r.text.replace(TYPED_BULLET, "") } : r));
        entries.push({ marker: "•", textIndent: bulletIndent, runs, blockEnd: false });
      });
    } else {
      const markers = block.items.map((_, i) => (block.ordered ? `${i + 1}.` : "•"));
      const textIndent = indentFor(markers);
      block.items.forEach((item, i) => {
        // Listeneintraege koennen eingebettete \n tragen (Zeilenumbruch im Punkt) -> Folgezeilen
        // gehoeren zum selben Punkt und stehen auf derselben Texteinrueckung.
        const lines = splitRunsIntoLines(item);
        lines.forEach((line, li) => entries.push({ marker: li === 0 ? markers[i]! : null, textIndent, runs: line, blockEnd: false }));
      });
    }
    if (entries.length > start) entries[entries.length - 1]!.blockEnd = true;
  }
  return entries;
}

interface PlacedEntry {
  entry: Entry;
  lines: WrappedLine[];
}

function layoutEntries(doc: PDFKit.PDFDocument, blocks: Block[], opts: RenderPdfOptions): { placed: PlacedEntry[]; lineHeight: number; size: number; base: string } {
  const base = opts.font ?? "Helvetica";
  const size = opts.fontSize ?? 10;
  const entries = buildEntries(doc, blocks, base, size);
  const placed = entries.map((entry) => ({
    entry,
    lines: wrapRuns(doc, styled(base, entry.runs), Math.max(opts.width - entry.textIndent, 1), size),
  }));
  doc.font(base).fontSize(size);
  return { placed, lineHeight: doc.currentLineHeight(true), size, base };
}

/** Abstand nach einem Eintrag (pt), abhaengig vom Nachfolger. */
function gapAfter(cur: Entry, next: Entry | undefined, lineHeight: number): number {
  if (!next) return PARAGRAPH_SPACING * lineHeight;
  if (cur.marker !== null && next.marker !== null) return LIST_ITEM_SPACING * lineHeight;
  if (!cur.blockEnd) return cur.marker !== null || next.marker !== null ? LIST_ITEM_SPACING * lineHeight : 0;
  // Fortsetzungszeile eines Listenpunkts gefolgt von einem weiteren Punkt
  return PARAGRAPH_SPACING * lineHeight;
}

/** Misst den Rich-Text: Gesamtzeilenzahl und die Hoehe der ersten `lead` Zeilen. */
export function measureRichTextPdf(doc: PDFKit.PDFDocument, blocks: Block[], opts: RenderPdfOptions, lead = 2): { lineCount: number; lineHeight: number; leadHeight: number } {
  const { placed, lineHeight } = layoutEntries(doc, blocks, opts);
  const lineCount = placed.reduce((s, p) => s + p.lines.length, 0);
  return { lineCount, lineHeight, leadHeight: Math.min(lead, lineCount) * lineHeight };
}

/**
 * Rendert Blöcke ab `doc.y`; danach steht `doc.y` unter dem letzten Absatz (inkl.
 * Absatzabstand), wie bisher.
 */
export function renderRichTextPdf(doc: PDFKit.PDFDocument, blocks: Block[], opts: RenderPdfOptions): void {
  const { placed, lineHeight, size, base } = layoutEntries(doc, blocks, opts);
  let y = doc.y;
  placed.forEach((p, ei) => {
    const { entry, lines } = p;
    if (ei > 0) y += gapAfter(placed[ei - 1]!.entry, entry, lineHeight);
    lines.forEach((line, li) => {
      // Mindestens zwei Zeilen eines mehrzeiligen Punkts zusammenhalten (keine einzelne
      // Zeile allein am Seitenende).
      const needed = li === 0 && lines.length >= 2 ? 2 * lineHeight : lineHeight;
      y = opts.ensureSpace ? opts.ensureSpace(y, needed) : y;
      if (opts.color) doc.fillColor(opts.color);
      if (li === 0 && entry.marker !== null) {
        doc.font(base).fontSize(size);
        doc.text(entry.marker, opts.x + MARKER_INDENT, y, { lineBreak: false });
      }
      drawWrappedLine(doc, line, opts.x + entry.textIndent, y, size);
      y += lineHeight;
    });
  });
  doc.font(base).fontSize(size);
  doc.y = y + (placed.length > 0 ? PARAGRAPH_SPACING * lineHeight : 0);
}

export interface RenderPlainTextOptions {
  x: number;
  width: number;
  font?: string;
  fontSize: number;
  align?: "left" | "right" | "center";
  ensureSpace?: (y: number, needed: number) => number;
  color?: string;
}

/**
 * Setzt Klartext (mit \n) ab (x, y) zeilenweise mit Seitenumbruch-Hook und liefert die
 * y-Position UNTER der letzten Zeile. Ersatz fuer `doc.text(text, x, y, { width })` an allen
 * Stellen, an denen der Text bis an die Fusszeile reichen kann.
 */
export function renderPlainTextPdf(doc: PDFKit.PDFDocument, text: string, y: number, opts: RenderPlainTextOptions): number {
  const font = opts.font ?? "Helvetica";
  doc.font(font).fontSize(opts.fontSize);
  const lineHeight = doc.currentLineHeight(true);
  const lines: WrappedLine[] = [];
  for (const logical of text.replace(/\r\n/g, "\n").split("\n")) {
    lines.push(...wrapRuns(doc, [{ text: logical, font }], opts.width, opts.fontSize));
  }
  let cy = y;
  lines.forEach((line, i) => {
    const needed = i === 0 && lines.length >= 2 ? 2 * lineHeight : lineHeight;
    cy = opts.ensureSpace ? opts.ensureSpace(cy, needed) : cy;
    if (opts.color) doc.fillColor(opts.color);
    const free = Math.max(opts.width - line.width, 0);
    const dx = opts.align === "right" ? free : opts.align === "center" ? free / 2 : 0;
    drawWrappedLine(doc, line, opts.x + dx, cy, opts.fontSize);
    cy += lineHeight;
  });
  doc.font(font).fontSize(opts.fontSize);
  doc.y = cy;
  return cy;
}
