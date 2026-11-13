/**
 * BT-22 (cbc:Note / ram:IncludedNote) — Abzugsaufstellung für Schlussrechnungen
 * (Phase 5, §14 Abs. 5 Satz 2 UStG). Wird von xrechnung.ts UND cii.ts als ZUSÄTZLICHES
 * Note-Element ausgegeben (mehrere Note-Elemente sind in beiden Formaten zulässig) —
 * ein bereits vorhandener Freitext-Hinweis (z. B. Kleinunternehmer) bleibt unangetastet.
 * Wortlaut je Belegsprache aus docStrings(lang).notes.
 */
import { berlinParts } from "@/lib/berlin-time";
import { docLocale, docStrings } from "@/lib/i18n/doc";
import type { DocLanguage } from "@/lib/i18n/doc/types";
import type { EInvoiceDeduction } from "./types";

function money(cents: number, lang: DocLanguage): string {
  return new Intl.NumberFormat(docLocale(lang), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

function date(d: Date, lang: DocLanguage): string {
  // Berliner Kalendertag, unabhaengig von der Prozess-TZ.
  const { year: y, month, day: dd } = berlinParts(d);
  const m = String(month).padStart(2, "0");
  const day = String(dd).padStart(2, "0");
  return lang === "en" ? `${day}/${m}/${y}` : `${day}.${m}.${y}`;
}

/** "Abzüge: RE-001 vom 01.02.2040: 3.000,00 netto + 570,00 USt = 3.570,00; ..." bzw. englisch. */
export function deductionsNoteText(deductions: EInvoiceDeduction[], lang: DocLanguage = "de"): string {
  const n = docStrings(lang).notes;
  const parts = deductions.map((d) =>
    n.deductionLine(d.number, date(d.issueDate, lang), money(d.netCents, lang), money(d.taxCents, lang), money(d.grossCents, lang)),
  );
  return `${n.deductionsPrefix}${parts.join("; ")}`;
}
