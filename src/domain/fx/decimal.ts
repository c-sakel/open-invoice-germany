/**
 * Kurse als Integer-Micros (1 EUR = rateMicros / 1e6 Fremdwaehrung). Kein Float:
 * Parser und Formatierer arbeiten rein auf Strings/Integern.
 * Die DB-Spalte ist ein 32-Bit-Int; Kurse ueber MAX_RATE_MICROS (z. B. IDR ~17000)
 * werden bewusst abgelehnt statt still abgeschnitten.
 */

/** Hoechster unterstuetzter Kurs: 2000 Fremdwaehrungseinheiten je EUR (passt in 32-Bit-Int). */
export const MAX_RATE_MICROS = 2_000_000_000;

/** Wirft RangeError mit deutscher Meldung, wenn der Kurs nicht in 1..MAX_RATE_MICROS liegt. */
export function assertSupportedRate(rateMicros: number): void {
  if (!Number.isInteger(rateMicros) || rateMicros < 1) {
    throw new RangeError("Kurs ungueltig: muss eine positive ganze Micro-Zahl sein.");
  }
  if (rateMicros > MAX_RATE_MICROS) {
    throw new RangeError(
      "Kurs nicht unterstuetzt: hoechstens 2000 Einheiten der Fremdwaehrung je EUR moeglich (Waehrungen wie IDR sind nicht abbildbar).",
    );
  }
}

/** "1,1214" / "1.1214" -> 1121400. Hoechstens 6 Nachkommastellen, Bereich 1..MAX_RATE_MICROS. */
export function parseRateMicros(s: string): number {
  const m = /^(\d+)(?:[.,](\d{1,6}))?$/.exec(s.trim());
  if (!m) throw new RangeError("Kurs ungueltig: Zahl mit hoechstens 6 Nachkommastellen erwartet.");
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(6, "0"));
  const micros = whole * BigInt(1_000_000) + frac;
  if (micros > BigInt(MAX_RATE_MICROS)) assertSupportedRate(MAX_RATE_MICROS + 1);
  const n = Number(micros);
  assertSupportedRate(n);
  return n;
}

/** Anzeige: mindestens 4, hoechstens 6 Nachkommastellen (Nullen ab der 5. Stelle gekuerzt). */
export function formatRate(micros: number, locale: "de-DE" | "en-GB"): string {
  assertSupportedRate(micros);
  const whole = Math.floor(micros / 1_000_000);
  let frac = String(micros % 1_000_000).padStart(6, "0");
  while (frac.length > 4 && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${whole}${locale === "de-DE" ? "," : "."}${frac}`;
}
