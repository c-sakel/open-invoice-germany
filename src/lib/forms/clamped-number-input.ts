/**
 * Fix-Welle 12a (M6): reine Hilfsfunktion fuer `<input type="number">`-Handler mit
 * harter Wertespanne (GiroCode-Groesse 15-40 mm, Logobreite 10-140 mm). Bisher stand an
 * allen drei Stellen direkt `Number(e.target.value)` — ein geleertes Feld (leerer
 * String) ergibt dabei `0`, was erst serverseitig von Zod mit 400 abgelehnt wird statt
 * einer Feldmeldung, und mit den jetzt engeren Spannen (15-40 statt vorher fix 30)
 * leichter zu treffen ist. `Number.isNaN`-Eingaben (nicht-numerischer Rest waehrend des
 * Tippens) und ein leeres Feld werden auf `min` abgebildet, gueltige Werte ausserhalb der
 * Spanne auf die naeheste Grenze geklemmt — der Nutzer sieht nie einen Wert, den Zod
 * anschliessend ablehnen wuerde.
 */
export function parseClampedNumberInput(raw: string, min: number, max: number): number {
  if (raw.trim() === "") return min;
  const n = Number(raw);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
