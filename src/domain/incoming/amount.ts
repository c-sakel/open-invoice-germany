/**
 * Betraege und Dezimalzahlen aus fremden Dateien. Kein Float: Betraege laufen als Text durch BigInt.
 */
import { MAX_AMOUNT_CENTS } from "./limits";

const DECIMAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
const MAX_DECIMAL_CHARS = 60;

/**
 * Cent-Wert eines XML-Betrags (Punkt als Dezimaltrenner). Ab der dritten Nachkommastelle kaufmaennisch
 * (Half-Up, vom Betrag weg) gerundet. `null` bei ungueltiger Schreibweise; `overflow` bei Betraegen
 * ueber 21.474.836,47.
 */
export function parseXmlAmountCents(s: string | null | undefined): { cents: number | null; overflow: boolean } {
  if (s == null) return { cents: null, overflow: false };
  const t = s.trim();
  if (t.length === 0 || !DECIMAL.test(t)) return { cents: null, overflow: false };
  if (t.length > MAX_DECIMAL_CHARS) return { cents: null, overflow: true };
  const negative = t.startsWith("-");
  const unsigned = t.replace(/^[+-]/, "");
  const [intPartRaw, fracRaw = ""] = unsigned.split(".");
  const intPart = intPartRaw === "" ? "0" : intPartRaw;
  const frac = fracRaw.padEnd(3, "0");
  let cents = BigInt(intPart) * BigInt(100) + BigInt(frac.slice(0, 2));
  if (frac.charCodeAt(2) >= 53) cents += BigInt(1); // '5'..'9'
  if (cents > BigInt(MAX_AMOUNT_CENTS)) return { cents: null, overflow: true };
  const n = Number(cents);
  return { cents: negative && n !== 0 ? -n : n, overflow: false };
}

/**
 * Menge/Preis zur Anzeige: Vorzeichen '+' entfernt, fuehrende Null ergaenzt, "-0" wird "0". Die Stellen
 * bleiben erhalten. `null` bei ungueltiger Schreibweise.
 */
export function normalizeDecimalString(s: string): string | null {
  const t = s.trim();
  if (t.length === 0 || t.length > MAX_DECIMAL_CHARS || !DECIMAL.test(t)) return null;
  const negative = t.startsWith("-");
  let u = t.replace(/^[+-]/, "");
  if (u.startsWith(".")) u = `0${u}`;
  const isZero = /^0*(\.0*)?$/.test(u);
  return negative && !isZero ? `-${u}` : u;
}
