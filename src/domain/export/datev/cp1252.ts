/**
 * Windows-1252 (CP1252) fuer Dateien im DATEV-Format.
 * Quelle: DATEV-Format, Abschnitt Zeichensatz — Standard fuer den Import ist ISO-8859-1 bzw. CodePage 1252;
 * Unicode nur mit BOM und nicht ueber alle Importwege (die DATEV-Anwendung KrStaPv kennt kein Unicode).
 * Zeichen 0x00-0x7F und 0xA0-0xFF entsprechen Unicode; 0x80-0x9F nach der Windows-Tabelle unten.
 * Das Euro-Zeichen wird zu "EUR" (nicht 0x80). Gaengige Zeichen ausserhalb der Tabelle (Akzentbuchstaben, typografische
 * Striche und Leerzeichen) werden transliteriert, alles Uebrige zu "?" (je Zeichen, nicht je UTF-16-Einheit);
 * `unmappableChars` nennt diese Zeichen, damit der Aufrufer sie melden kann.
 */
const HIGH_BLOCK: ReadonlyMap<number, number> = new Map([
  [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e],
  [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96],
  [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

const SPECIAL: ReadonlyMap<number, string> = new Map([
  [0x0141, "L"], [0x0142, "l"], [0x0110, "D"], [0x0111, "d"], [0x0131, "i"], [0x0126, "H"], [0x0127, "h"],
  [0x2010, "-"], [0x2011, "-"], [0x2012, "-"], [0x2015, "-"], [0x2212, "-"],
  [0x2002, " "], [0x2003, " "], [0x2009, " "], [0x200a, " "], [0x202f, " "], [0x2007, " "], [0x2008, " "],
  [0x200b, ""], [0x200c, ""], [0x200d, ""], [0xfeff, ""],
  [0x201b, "'"], [0x2032, "'"], [0x2033, '"'], [0x2024, "."], [0x2027, "."], [0x00ad, ""],
]);

function direct(cp: number): boolean {
  return cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) || HIGH_BLOCK.has(cp) || cp === 0x20ac;
}

/** Ersatz fuer ein Zeichen ausserhalb der Tabelle (Basisbuchstabe ohne Akzent, typografisches Zeichen) oder null. */
function transliterate(ch: string): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  const special = SPECIAL.get(cp);
  if (special !== undefined) return special;
  const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (base !== ch && base !== "" && Array.from(base).every((c) => (c.codePointAt(0) ?? 0xffff) < 0x80)) return base;
  return null;
}

/** Zeichen von `s`, die weder direkt noch per Transliteration darstellbar sind (je Zeichen einmal, in Reihenfolge). */
export function unmappableChars(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!direct(cp) && transliterate(ch) === null && !out.includes(ch)) out.push(ch);
  }
  return out;
}

export function encodeCp1252(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    if (cp === 0x20ac) {
      out.push(0x45, 0x55, 0x52);
    } else if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) {
      out.push(cp);
    } else if (HIGH_BLOCK.has(cp)) {
      out.push(HIGH_BLOCK.get(cp) ?? 0x3f);
    } else {
      const t = transliterate(ch);
      if (t === null) out.push(0x3f);
      else for (const c of t) out.push(c.codePointAt(0) ?? 0x3f);
    }
  }
  return Buffer.from(out);
}
