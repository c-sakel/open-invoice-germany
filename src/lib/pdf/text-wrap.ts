/**
 * Eigener Zeilenumbruch fuer die pdfkit-Renderer (fix/pdf-umbrueche).
 *
 * Warum nicht `doc.text(..., { width })`: pdfkit bricht intern um und paginiert dabei nur
 * gegen `margins.bottom` — die Fusszeilen-Reserve der Layouts kennt es nicht (Text lief in
 * die Fusszeile), und es trennt an jedem Bindestrich ("E-Mail- / Sicherheit"), sodass
 * Textextraktoren, die Silbentrennung am Zeilenende zurueckbauen, das "-" verlieren
 * ("E-MailSicherheit"). Hier wird vorab in Zeilen zerlegt; der Aufrufer zeichnet jede Zeile
 * einzeln (`drawWrappedLine`) und kann davor Seitenumbrueche pruefen.
 *
 * Regeln: Umbruch nur an Leerzeichen. Ein einzelnes Wort, das breiter als die Zeile ist,
 * wird notfalls nach einem Bindestrich (Bindestrich bleibt in der Zeile erhalten), sonst
 * zeichenweise getrennt.
 */

export interface StyledRun {
  text: string;
  font: string;
  underline?: boolean;
  href?: string;
}

export interface LineSegment {
  text: string;
  font: string;
  width: number;
  underline?: boolean;
  href?: string;
}

export interface WrappedLine {
  segments: LineSegment[];
  width: number;
}

interface Piece {
  text: string;
  run: StyledRun;
  width: number;
}

function measure(doc: PDFKit.PDFDocument, font: string, size: number, text: string): number {
  doc.font(font).fontSize(size);
  return doc.widthOfString(text);
}

/** Zerlegt Runs in Woerter (Liste von Stuecken, da ein Wort mehrere Runs ueberspannen kann)
 *  und einzelne Leerzeichen-Trenner (`null`). Mehrfache Leerzeichen werden zu einem. */
function toWords(runs: StyledRun[]): ({ run: StyledRun; text: string }[] | null)[] {
  const words: ({ run: StyledRun; text: string }[] | null)[] = [];
  let open = false;
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (part === "") continue;
      if (/^\s+$/.test(part)) {
        if (open || words.length > 0) {
          if (words[words.length - 1] !== null) words.push(null);
        }
        open = false;
        continue;
      }
      if (open) words[words.length - 1]!.push({ run, text: part });
      else {
        words.push([{ run, text: part }]);
        open = true;
      }
    }
  }
  if (words[words.length - 1] === null) words.pop();
  return words;
}

/** Zerlegt ein zu breites Wort in Stuecke <= `avail` (erstes Stueck) bzw. `full` (Rest). */
function splitWideWord(doc: PDFKit.PDFDocument, size: number, word: Piece[], avail: number, full: number): Piece[][] {
  const chars: Piece[] = [];
  for (const p of word) {
    for (const ch of Array.from(p.text)) chars.push({ text: ch, run: p.run, width: measure(doc, p.run.font, size, ch) });
  }
  const out: Piece[][] = [];
  let cur: Piece[] = [];
  let w = 0;
  let limit = avail;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (cur.length > 0 && w + c.width > limit) {
      // bevorzugt nach dem letzten Bindestrich im bisherigen Stueck trennen
      let cut = -1;
      for (let k = cur.length - 1; k > 0; k--) if (cur[k]!.text === "-") { cut = k + 1; break; }
      if (cut > 0 && cut < cur.length) {
        const rest = cur.slice(cut);
        out.push(cur.slice(0, cut));
        cur = rest;
        w = rest.reduce((s, p) => s + p.width, 0);
      } else {
        out.push(cur);
        cur = [];
        w = 0;
      }
      limit = full;
    }
    cur.push(c);
    w += c.width;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function toSegments(pieces: Piece[]): LineSegment[] {
  const segments: LineSegment[] = [];
  for (const p of pieces) {
    const last = segments[segments.length - 1];
    if (last && last.font === p.run.font && last.underline === p.run.underline && last.href === p.run.href) {
      last.text += p.text;
      last.width += p.width;
    } else {
      segments.push({ text: p.text, font: p.run.font, width: p.width, underline: p.run.underline, href: p.run.href });
    }
  }
  return segments;
}

/**
 * Bricht Runs (eine logische Zeile ohne `\n`) gierig auf `width` um. Liefert mindestens
 * eine Zeile (leer, wenn der Text leer ist).
 */
export function wrapRuns(doc: PDFKit.PDFDocument, runs: StyledRun[], width: number, size: number): WrappedLine[] {
  const words = toWords(runs);
  const lines: WrappedLine[] = [];
  let pieces: Piece[] = [];
  let w = 0;
  const pushLine = (): void => {
    // Leerzeichen am Zeilenende entfaellt bereits, da Leerzeichen erst vor dem naechsten Wort eingefuegt werden.
    lines.push({ segments: toSegments(pieces), width: w });
    pieces = [];
    w = 0;
  };
  const lastRunOf = (ps: Piece[]): StyledRun => ps[ps.length - 1]!.run;

  for (const word of words) {
    if (word === null) continue;
    const wp: Piece[] = word.map((p) => ({ text: p.text, run: p.run, width: measure(doc, p.run.font, size, p.text) }));
    const ww = wp.reduce((s, p) => s + p.width, 0);
    const spaceW = pieces.length > 0 ? measure(doc, lastRunOf(pieces).font, size, " ") : 0;

    if (pieces.length > 0 && w + spaceW + ww > width) pushLine();
    if (pieces.length === 0 && ww > width) {
      const parts = splitWideWord(doc, size, wp, width, width);
      parts.forEach((part, idx) => {
        if (idx < parts.length - 1) {
          pieces = part;
          w = part.reduce((s, p) => s + p.width, 0);
          pushLine();
        } else {
          pieces = part;
          w = part.reduce((s, p) => s + p.width, 0);
        }
      });
      continue;
    }
    if (pieces.length > 0) {
      const sp = lastRunOf(pieces);
      pieces.push({ text: " ", run: sp, width: spaceW });
      w += spaceW;
    }
    pieces.push(...wp);
    w += ww;
  }
  if (pieces.length > 0 || lines.length === 0) pushLine();
  return lines;
}

/** Bricht Klartext (mit `\n`) in der gegebenen Schrift um; liefert die Zeilen als Strings. */
export function wrapPlain(doc: PDFKit.PDFDocument, text: string, width: number, font: string, size: number): string[] {
  const out: string[] = [];
  for (const logical of text.replace(/\r\n/g, "\n").split("\n")) {
    const lines = wrapRuns(doc, [{ text: logical, font }], width, size);
    for (const l of lines) out.push(l.segments.map((s) => s.text).join(""));
  }
  return out;
}

/** Zeichnet eine umgebrochene Zeile ab (x, y); `lineBreak: false`, pdfkit bricht nicht selbst um. */
export function drawWrappedLine(doc: PDFKit.PDFDocument, line: WrappedLine, x: number, y: number, size: number): void {
  let cx = x;
  for (const seg of line.segments) {
    doc.font(seg.font).fontSize(size);
    const options: PDFKit.Mixins.TextOptions = { lineBreak: false, underline: seg.underline === true };
    if (seg.href) options.link = seg.href;
    doc.text(seg.text, cx, y, options);
    cx += seg.width;
  }
}
