import { assertSupportedRate } from "./decimal";

/**
 * Fremdwaehrungs-Cent -> EUR-Cent: cents * 1e6 / rateMicros, halbes Runden weg von null
 * (symmetrisch fuer negative Betraege). Reine Integer-Arithmetik ueber BigInt.
 */
export function toEurCents(cents: number, rateMicros: number): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError("Betrag muss eine ganze Cent-Zahl sein.");
  assertSupportedRate(rateMicros);
  const neg = cents < 0;
  const abs = BigInt(neg ? -cents : cents);
  const r = BigInt(rateMicros);
  const q = (abs * BigInt(1_000_000) * BigInt(2) + r) / (BigInt(2) * r);
  const out = Number(q);
  if (!Number.isSafeInteger(out)) throw new RangeError("Umrechnung ueberschreitet den Zahlenbereich.");
  return neg ? -out : out;
}
