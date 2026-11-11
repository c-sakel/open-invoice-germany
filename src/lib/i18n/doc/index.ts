/**
 * Beleg-Uebersetzungen (Phase 16b, Task 5): Sprachwahl, Locale und Formatierer.
 * Unbekannte oder fehlende Sprachcodes fallen auf Deutsch zurueck.
 */
import { de } from "./de";
import { en } from "./en";
import type { DocLanguage, DocStrings } from "./types";

export type { DocLanguage, DocStrings, NoticeCategory, NoticeScheme, FxSource } from "./types";

export const DOC_LANGUAGES: readonly DocLanguage[] = ["de", "en"];

const STRINGS = { de, en } satisfies Record<DocLanguage, DocStrings>;

export function resolveDocLanguage(code: string | null | undefined): DocLanguage {
  const norm = (code ?? "").trim().toLowerCase();
  return norm === "en" ? "en" : "de";
}

export function docStrings(lang: DocLanguage): DocStrings {
  return STRINGS[lang];
}

export function docLocale(lang: DocLanguage): "de-DE" | "en-GB" {
  return lang === "en" ? "en-GB" : "de-DE";
}

/** Datum tt.mm.jjjj bzw. dd/mm/yyyy, in Europe/Berlin (wie die bisherigen PDF-Formatierer). */
export function formatDocDate(d: Date, lang: DocLanguage): string {
  return new Intl.DateTimeFormat(docLocale(lang), { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" }).format(d);
}

export function formatDocMoney(cents: number, currency: string, lang: DocLanguage): string {
  return new Intl.NumberFormat(docLocale(lang), { style: "currency", currency }).format(cents / 100);
}
