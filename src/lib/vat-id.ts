/**
 * Phase 17a — reine Hilfen zur USt-IdNr. (Normalisierung, Formatpruefung, Aufteilung).
 * Keine Pruefung der Existenz (das macht VIES, Task 6); nur das Format.
 */
import { EU_VAT_PREFIXES } from "@/lib/tax";

/** Entfernt Leerzeichen, Punkte und Bindestriche, setzt Grossbuchstaben, GR wird EL. */
export function normalizeVatId(raw: string): string {
  const s = raw.replace(/[\s.\-]/g, "").toUpperCase();
  return s.startsWith("GR") ? `EL${s.slice(2)}` : s;
}

/** Deutsche Meldung bei Formatproblem, sonst null. Erwartet beliebige Schreibweise. */
export function vatIdFormatProblem(vatId: string): string | null {
  const v = normalizeVatId(vatId);
  if (v.length < 4) return "USt-IdNr. ist zu kurz.";
  const prefix = v.slice(0, 2);
  if (!EU_VAT_PREFIXES.has(prefix)) return `Länderpräfix ${prefix} ist keine EU-USt-IdNr.`;
  const rest = v.slice(2);
  if (prefix === "DE") {
    return /^[0-9]{9}$/.test(rest) ? null : "Deutsche USt-IdNr. besteht aus DE und 9 Ziffern.";
  }
  return /^[0-9A-Z+*]{2,12}$/.test(rest) ? null : "USt-IdNr. hat ein ungültiges Format.";
}

export function splitVatId(vatId: string): { countryCode: string; number: string } {
  const v = normalizeVatId(vatId);
  return { countryCode: v.slice(0, 2), number: v.slice(2) };
}
