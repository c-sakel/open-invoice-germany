/**
 * Vorpruefung einer Bank-Antwort vor dem Dekodieren. Die Bibliothek springt bei einem unmaskierten `@` ohne
 * schliessendes `@` (oder mit negativer Laenge) rueckwaerts und laeuft endlos; dieser Zaehler liest die Binaerbloecke
 * strenger und in einem Durchlauf (O(n)).
 *
 * Zaehlt Segmentenden (unmaskiertes `'`), beachtet `?`-Maskierung und `@laenge@`-Binaerbloecke; der Binaerblock eines
 * HNVSD-Segments (verschachtelte Segmente) wird mitgezaehlt. Rueckgabe: Anzahl, bei Ueberschreitung von `cap` sofort
 * `cap + 1`, bei ungueltiger Binaerlaenge -1.
 */
export function countSegmentEnds(text: string, cap: number): number {
  let n = 0;
  let segStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 63) {
      i++;
      continue;
    }
    if (c === 64) {
      const j = text.indexOf("@", i + 1);
      if (j < 0 || j === i + 1 || j - i > 9) return -1;
      const digits = text.slice(i + 1, j);
      if (!/^\d{1,8}$/.test(digits)) return -1;
      const len = Number(digits);
      if (j + len >= text.length) return -1;
      if (text.startsWith("HNVSD:", segStart)) {
        // Inhalt sind Segmente: normal weiterzaehlen.
        i = j;
        continue;
      }
      i = j + len;
      continue;
    }
    if (c === 39) {
      if (++n > cap) return n;
      segStart = i + 1;
    }
  }
  return n;
}
