/**
 * Layout-Bausteine (Phase 11b), die mehrere PdfLayouts teilen: Empfaengerblock,
 * rechtsbuendige/-zweispaltige Meta-Zeilen, Tabellenkopfzeile, Fusszeilen-Spalten,
 * Logo+Absenderzeile. Reine Zeichenfunktionen auf einem `LayoutFrame` — kein
 * Layout-spezifisches Wissen (das liefert `layout.table`/`layout.footerHeight`).
 */
import type { LayoutFrame, KopfInput, FooterColumn, PdfLayout } from "./types";
import { drawLogo, drawSenderLine } from "../layout";
import { wrapPlain } from "../text-wrap";

/**
 * Empfaengerblock (DIN-5008-Fenster); liefert Unterkante.
 *
 * Follow-up (Reviews, Task 5): bisher ohne `width` — ein langer Empfaengername lief in
 * den rechten Infoblock (Meta-Zeilen/-Tabelle) hinein, weil pdfkit ohne `width` bis zum
 * Seitenrand umbricht. `maxWidth` begrenzt jede Zeile des Blocks auf die linke Spalte.
 *
 * Fix-Runde 1 (Task-5-Review): der urspruengliche Default `frame.width - 220` war
 * margin-abhaengig, obwohl `standard`/`klassik` (und via Delegation blau/schwarz/kompakt)
 * ihren Infoblock an einem FESTEN `left + 250` verankern — bei den Standard-18mm-Raendern
 * ergab das ~273pt (23pt zu weit, ueberlappt bereits leicht die Meta-Spalte), bei den
 * schema-erlaubten 5mm-Raendern sogar ~347pt. Der Default ist jetzt der feste Wert `240`
 * (= 250 − 10pt Abstand), unabhaengig von `frame.width`/den Raendern; `standard` und
 * `klassik` reichen ihn zusaetzlich explizit durch (statt sich auf den Default zu
 * verlassen), analog zu `schlicht`/`modern`, die ihre eigene (schmalere, weiter links
 * beginnende) Infoblock-Breite durchreichen (Infoblock-x minus 10pt Abstand minus `left`).
 */
export function drawRecipient(frame: LayoutFrame, input: KopfInput, y: number, size = 11, maxWidth = 240): number {
  const { doc, left } = frame;
  const r = input.recipient;
  doc.fillColor("#000").font("Helvetica").fontSize(size);
  doc.text(r.name, left, y, { width: maxWidth });
  if (r.contactName) doc.text(r.contactName, { width: maxWidth });
  doc.text(r.addressLine1, { width: maxWidth });
  if (r.addressLine2) doc.text(r.addressLine2, { width: maxWidth });
  doc.text(`${r.postalCode} ${r.city}`, { width: maxWidth });
  if (r.countryLine) doc.text(r.countryLine, { width: maxWidth });
  if (input.extraRecipientBlock) {
    doc.fontSize(size - 2).fillColor("#555").text(input.extraRecipientBlock.heading, left, doc.y + 8, { width: maxWidth });
    doc.fontSize(size).fillColor("#000");
    for (const l of input.extraRecipientBlock.lines) doc.text(l, { width: maxWidth });
  }
  return doc.y;
}

/** Rechtsbuendige Meta-Zeilen "Label: Wert" ab (x, y); liefert Unterkante. */
export function drawMetaRows(frame: LayoutFrame, rows: { label: string; value: string }[], x: number, y: number, size = 10, color = "#333"): number {
  const { doc, right } = frame;
  doc.font("Helvetica").fontSize(size).fillColor(color);
  let first = true;
  for (const row of rows) {
    if (first) {
      doc.text(`${row.label}: ${row.value}`, x, y, { width: right - x, align: "right" });
      first = false;
    } else {
      doc.text(`${row.label}: ${row.value}`, { width: right - x, align: "right" });
    }
  }
  return doc.y;
}

/**
 * Zweispaltige Meta-Tabelle (Label links grau, Wert rechts) fuer Infobloecke im Stil moderner Belege;
 * liefert Unterkante.
 *
 * Fix-Runde 1 (Koordinator, Punkt 5 — derselbe Befund wie in `standard.ts` fuer die grosse
 * Beleg-Nummer, siehe Task 4): `lineBreak: false` wird vom gebuendelten pdfkit ignoriert,
 * sobald `width` gesetzt ist (der Zeilenumbruch-Wrapper laeuft trotzdem) — ein langes Label
 * oder ein langer Wert (z. B. `Bezug: zu Auftragsbestaetigung AB-2026-00001-...`) wuerde in
 * der engen Haelftenspalte umbrechen und mit der naechsten Zeile kollidieren. `height` +
 * `ellipsis: true` erzwingt stattdessen genau eine Zeile mit "…" am Ende.
 */
export function drawMetaTable(frame: LayoutFrame, rows: { label: string; value: string }[], x: number, y: number, width: number, size = 9): number {
  const { doc } = frame;
  let cy = y;
  const lineHeight = size + 3;
  for (const row of rows) {
    doc.font("Helvetica").fontSize(size).fillColor("#555").text(row.label, x, cy, { width: width / 2, height: lineHeight, ellipsis: true });
    doc.fillColor("#000").text(row.value, x + width / 2, cy, { width: width / 2, align: "right", height: lineHeight, ellipsis: true });
    cy += size + 4;
  }
  return cy;
}

export interface TableHeaderColumn {
  header: string;
  /** Absolute x-Position (bereits inkl. `tableX`-Offset des Aufrufers). */
  x: number;
  width: number;
  align?: "left" | "right";
  /** Beschreibungsspalte: Text entfaellt ohne `showDescription`, die Spaltenbreite bleibt
   *  trotzdem reserviert (Phase 7 — Rechnungs-Tabelle rueckt sonst zusammen). */
  isDescription?: boolean;
}

/**
 * Zeichnet die Tabellenkopfzeile nach `layout.table` (dunkler Balken bei `headerFill`,
 * sonst eine Linie) und liefert die y-Koordinate, an der die erste Datenzeile beginnt.
 * Von `invoice-pdf.ts` und `delivery-note-pdf.ts` gemeinsam genutzt (Phase 11b, Task 3
 * — vorher zwei fast identische Kopien).
 */
export function drawTableHeaderRow(frame: LayoutFrame, layout: PdfLayout, columns: TableHeaderColumn[], atY: number, showDescription: boolean): number {
  const { doc, left, right, base } = frame;
  const t = layout.table;
  doc.fontSize(base - 1);
  if (t.headerFill) {
    doc.rect(left, atY, right - left, t.headerHeight).fill(t.headerFill);
  } else {
    doc.moveTo(left, atY + t.headerHeight).lineTo(right, atY + t.headerHeight).strokeColor(t.rowRule ?? "#999").stroke();
  }
  doc.fillColor(t.headerText).font(t.headerFill ? "Helvetica" : "Helvetica-Oblique");
  for (const col of columns) {
    if (col.isDescription && !showDescription) continue;
    doc.text(col.header, col.x, atY + (t.headerFill ? 5 : 3), { width: col.width, align: col.align ?? "left" });
  }
  doc.font("Helvetica").fillColor(t.textColor).fontSize(base - 1);
  return atY + t.headerHeight + 4;
}

// Fusszeile (fix/pdf-umbrueche, B2): Felder, die nie innerhalb umbrechen duerfen (Kontakt-,
// Steuer- und Bankangaben: E-Mail, URL, USt-IdNr., IBAN ...). pdfkit trennte E-Mail/URL am
// Bindestrich ("contact@prepaid- / host.com") und schob die IBAN-Nummer in eine eigene
// Zeile. Die Zeilen werden jetzt selbst gesetzt (kein pdfkit-Umbruch); die Spaltenbreiten
// richten sich nach dem Inhalt, bei Platzmangel schrumpft erst die Schrift (bis -0,75 pt), dann Abstand und IBAN-
// Gruppierung; nur frei umbrechbare Zeilen (Firmenname,
// Anschrift, Freitext) werden als letzte Stufe an Leerzeichen umgebrochen.
// Unumbrechbar: Feldzeilen mit bekanntem Label (AUTO-Spalten) oder ein einzelnes Token mit @ bzw. ://
// (E-Mail/URL). Eine Freitextzeile mit @ oder :// MIT Leerzeichen ist frei umbrechbar.
const FIXED_FOOTER_LINE = /^(Tel\.|E-Mail|Web|USt-IdNr\.|Steuer-Nr\.|Inhaber\/-in|IBAN|BIC)\s|^\S*(@|:\/\/)\S*$/;
const IBAN_FOOTER_LINE = /^(IBAN )([A-Z0-9 ]+)$/;
const FOOTER_LINE_GAP = 1;

export interface FooterLayoutResult {
  size: number;
  lineHeight: number;
  columns: { x: number; width: number; lines: string[]; /** Zeilen-Offset (volle Breite unter den Spalten) */ top: number }[];
  /** Hoehe des hoechsten Fusszeilenblocks in pt (Zeilenanzahl x Zeilenhoehe). */
  height: number;
}

function ungroupIbanLine(line: string): string {
  const m = IBAN_FOOTER_LINE.exec(line);
  return m ? m[1] + m[2]!.replace(/\s+/g, "") : line;
}

function footerLineHeight(doc: PDFKit.PDFDocument): number {
  return doc.currentLineHeight(true) + FOOTER_LINE_GAP;
}

/** Berechnet Spaltenpositionen und Zeilen der Fusszeile (ohne zu zeichnen). `fullWidth`-Spalten
 *  (Kontoinhaber) stehen einzeilig ueber die volle Breite unter dem Spaltenblock — es sei denn, sie
 *  tragen `preferBankColumn` und das Raster bleibt mit der Zeile in dieser Spalte (vor der IBAN)
 *  unveraendert (gleiche Schrift, keine andere Spalte bricht um, Zeile selbst ungebrochen). */
export function layoutFooterColumns(frame: LayoutFrame, columns: FooterColumn[], size = 7.5): FooterLayoutResult {
  const nonEmpty = columns.filter((c) => c.lines.length > 0);
  let rows = nonEmpty.filter((c) => c.fullWidth);
  let grid = nonEmpty.filter((c) => !c.fullWidth);
  if (rows.length === 0 || grid.length === 0) return layoutGrid(frame, nonEmpty, size);
  let main = layoutGrid(frame, grid, size);
  for (const row of rows) {
    if (!row.preferBankColumn) continue;
    const idx = grid.findIndex((c) => c.lines.some((l) => /^IBAN /.test(l)));
    const target = grid[idx];
    if (!target) continue;
    const lines = row.lines.flatMap((l) => l.split("\n"));
    const at = target.lines.findIndex((l) => IBAN_FOOTER_LINE.test(l) || /^IBAN /.test(l));
    const merged = at < 0 ? [...target.lines, ...lines] : [...target.lines.slice(0, at), ...lines, ...target.lines.slice(at)];
    const candGrid = grid.map((c, i) => (i === idx ? { ...c, lines: merged } : c));
    const cand = layoutGrid(frame, candGrid, size);
    const better = (a: FooterLayoutResult, b: FooterLayoutResult): boolean =>
      a.size === b.size &&
      a.columns.length === b.columns.length &&
      a.columns.every((col, i) => {
        if (i !== idx) return col.lines.join("\n") === b.columns[i]!.lines.join("\n");
        // Bank-Spalte: alte Zeilen unveraendert (IBAN gruppiert wie zuvor), plus die eine, ungebrochene Kontoinhaber-Zeile
        return col.lines.length === b.columns[i]!.lines.length + lines.length && lines.every((l) => col.lines.includes(l)) && b.columns[i]!.lines.every((l) => col.lines.includes(l));
      });
    if (better(cand, main)) {
      grid = candGrid;
      main = cand;
      rows = rows.filter((r) => r !== row);
    }
  }
  if (rows.length === 0) return main;
  const { doc, left, width } = frame;
  doc.font("Helvetica").fontSize(main.size);
  const placed = main.columns.slice();
  let top = main.columns.length > 0 ? Math.max(...main.columns.map((c) => c.lines.length)) : 0;
  for (const row of rows) {
    const lines = row.lines.flatMap((l) => l.split("\n")).flatMap((l) => wrapPlain(doc, l, width + 0.01, "Helvetica", main.size));
    placed.push({ x: left, width, lines, top });
    top += lines.length;
  }
  return { size: main.size, lineHeight: main.lineHeight, columns: placed, height: top * main.lineHeight };
}

function layoutGrid(frame: LayoutFrame, columns: FooterColumn[], size: number): FooterLayoutResult {
  const { doc, left, width } = frame;
  const visible = columns;
  const empty: FooterLayoutResult = { size, lineHeight: 0, columns: [], height: 0 };
  if (visible.length === 0) return empty;
  const logical = visible.map((c) => c.lines.flatMap((l) => l.split("\n")));

  // wrap: 0 = kein Umbruch, 1 = Feldzeilen bleiben unumbrechbar, 2 = alles an Woertern umbrechbar,
  // 3 = wie 2, Spalten duerfen zusaetzlich unter die Wort-Mindestbreite schrumpfen (zu lange Woerter
  // werden hart getrennt) — damit die Fusszeile nie verschwindet.
  const attempt = (s: number, gap: number, ungroup: boolean, wrap: 0 | 1 | 2 | 3): FooterLayoutResult | null => {
    const isFixed = (l: string): boolean => wrap === 1 && FIXED_FOOTER_LINE.test(l);
    doc.font("Helvetica").fontSize(s);
    const lineHeight = footerLineHeight(doc);
    const avail = width - gap * (visible.length - 1);
    const cols = logical.map((lines) => {
      const ls = ungroup ? lines.map(ungroupIbanLine) : lines;
      const widths = ls.map((l) => doc.widthOfString(l));
      const natural = Math.max(...widths);
      let min = natural;
      if (wrap) {
        min = 0;
        ls.forEach((l, i) => {
          if (isFixed(l)) min = Math.max(min, widths[i]!);
          else if (wrap < 3) for (const word of l.split(/\s+/)) min = Math.max(min, doc.widthOfString(word));
        });
      }
      return { ls, natural, min };
    });
    const naturalSum = cols.reduce((sum, c) => sum + c.natural, 0);
    let widths: number[];
    if (naturalSum <= avail) {
      const slack = (avail - naturalSum) / cols.length;
      widths = cols.map((c) => c.natural + slack);
    } else if (wrap && cols.reduce((sum, c) => sum + c.min, 0) <= avail) {
      const need = naturalSum - avail;
      const shrinkable = cols.reduce((sum, c) => sum + (c.natural - c.min), 0);
      widths = cols.map((c) => c.natural - (shrinkable > 0 ? (need * (c.natural - c.min)) / shrinkable : 0));
    } else {
      return null;
    }
    let x = left;
    let maxLines = 0;
    const placed = cols.map((c, i) => {
      const w = widths[i]!;
      const lines = wrap > 0 ? c.ls.flatMap((l) => (isFixed(l) ? [l] : wrapPlain(doc, l, w + 0.01, "Helvetica", s))) : c.ls;
      maxLines = Math.max(maxLines, lines.length);
      const col = { x, width: w, lines, top: 0 };
      x += w + gap;
      return col;
    });
    return { size: s, lineHeight, columns: placed, height: maxLines * lineHeight };
  };

  // Reihenfolge der Sparmassnahmen: erst Schrift (bis -0,75 pt) bei vollem Spaltenabstand,
  // dann kleinerer Abstand; IBAN je Stufe erst gruppiert, dann zusammenhaengend.
  const plan: [number, number, boolean][] = [];
  for (let s = size; s >= size - 0.75; s -= 0.25) plan.push([s, 10, false], [s, 10, true]);
  plan.push([size, 8, true], [size, 6, true]);
  for (const [s, gap, ungroup] of plan) {
    const r = attempt(s, gap, ungroup, 0);
    if (r) return r;
  }
  return (
    attempt(size, 6, true, 1) ?? attempt(size, 4, true, 1) ??
    attempt(size, 4, true, 2) ?? attempt(size, 4, true, 3) ?? attempt(size - 0.75, 2, true, 3) ?? empty
  );
}

/** Hoehe der Fusszone (Layout-Mindesthoehe, bei umbrochenen/mehrzeiligen Spalten mehr). */
export function footerZoneHeight(frame: LayoutFrame, layout: PdfLayout, columns: FooterColumn[]): number {
  const measured = layoutFooterColumns(frame, columns, layout.footerFontSize).height;
  return measured === 0 ? layout.footerHeight : Math.max(layout.footerHeight, Math.ceil(measured) + 4);
}

/** Fusszeilen-Spalten nach Inhalt ueber die Breite; liefert nichts. */
export function drawFooterColumns(frame: LayoutFrame, columns: FooterColumn[], y: number, size = 7.5, color = "#666666"): void {
  const { doc } = frame;
  const laid = layoutFooterColumns(frame, columns, size);
  if (laid.columns.length === 0) return;
  doc.font("Helvetica").fontSize(laid.size).fillColor(color);
  for (const col of laid.columns) {
    col.lines.forEach((line, i) => {
      doc.text(line, col.x, y + (col.top + i) * laid.lineHeight, { lineBreak: false });
    });
  }
}

/**
 * Betreffzeile (Phase 13b): fett, Grundschriftgroesse des Layouts, volle Textbreite,
 * direkt ueber dem Kopftext. Genau EINE Implementierung fuer alle sieben Layouts —
 * `standard`, `schlicht`, `klassik`, `modern` rufen sie in ihrem `drawKopf` auf,
 * `blau`/`schwarz`/`kompakt` erben ueber styledLayout den Standard-Kopf.
 * Liefert die neue y-Position (pdfkit kann bei langem Betreff selbst umbrechen).
 */
export function drawSubject(frame: LayoutFrame, subject: string, y: number): number {
  // Nachtrag Task 7: getrimmt; leer/nur Whitespace zeichnet nichts (y unveraendert) —
  // dieselbe Regel wie beim Betreff im UBL-/CII-Mapping (cii.ts, xrechnung.ts).
  const trimmed = subject.trim();
  if (!trimmed) return y;
  const { doc, left, right, base } = frame;
  doc.font("Helvetica-Bold").fontSize(base).fillColor("#000").text(trimmed, left, y, { width: right - left });
  doc.font("Helvetica");
  return doc.y + 8;
}

export function drawLogoAndSender(frame: LayoutFrame, input: KopfInput): void {
  const { doc, theme, right, left, margins } = frame;
  drawLogo(doc, theme, right, margins.top);
  drawSenderLine(doc, theme, left, margins.top, input.senderFallback);
}
