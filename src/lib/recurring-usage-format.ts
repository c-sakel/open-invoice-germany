/** Anzeige und Eingabe von Verbrauchsmengen (Phase 18f): Milliunits <-> Text, rein und ohne Zeitzonenabhaengigkeit. */
import { parseDecimalInput } from "@/lib/money";

/** Milliunits als deutsche Zahl mit Tausenderpunkt und bis zu drei Nachkommastellen ("10.000", "2,5"). */
export function formatUsageQuantity(milli: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3, useGrouping: true }).format(milli / 1000);
}

/** Kalendertag (gespeichert um 12:00 UTC) als TT.MM.JJJJ, unabhaengig von der Serverzeitzone. */
export function formatUsageDay(d: Date): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** Heutiger Berliner Kalendertag als YYYY-MM-DD (Vorbelegung des Datumsfelds). */
export function berlinTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(now);
}

export const USAGE_QUANTITY_AMBIGUOUS = "Mehrdeutig: bitte ohne Tausenderpunkt (10000) oder mit Komma (10.000,5) eingeben.";
export const USAGE_QUANTITY_INVALID = "Menge nicht lesbar – bitte z. B. 2,5 eingeben (höchstens 3 Nachkommastellen, größer als 0).";

/** Menge aus dem Formular in Milliunits; "10.000" (ein Punkt, drei Ziffern, kein Komma) ist mehrdeutig. */
export function parseUsageQuantity(input: string): { milli: number } | { error: string } {
  const t = input.replace(/\s/g, "");
  if (!t.includes(",") && /^\d{1,3}\.\d{3}$/.test(t)) return { error: USAGE_QUANTITY_AMBIGUOUS };
  const milli = parseDecimalInput(t, 3);
  if (milli === null || milli < 1) return { error: USAGE_QUANTITY_INVALID };
  return { milli };
}
