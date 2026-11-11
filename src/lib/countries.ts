/**
 * Laendernamen fuer Anschriftszeilen: Landesname deutsch in Grossbuchstaben als letzte Zeile,
 * auf Betreiber-Wunsch (2026-10-09) bei JEDER Anschrift, auch im Inland. Quelle der Namen: Intl.DisplayNames("de") (ICU, im Node-Image enthalten —
 * Node >= 13 liefert full-icu); fehlt ein Name, wird der ISO-Code selbst gedruckt.
 */

import type { DocLanguage } from "@/lib/i18n/doc/types";

const displayNames: Partial<Record<DocLanguage, Intl.DisplayNames | null>> = {};

function getDisplayNames(lang: DocLanguage = "de"): Intl.DisplayNames | null {
  if (displayNames[lang] === undefined) {
    try {
      displayNames[lang] = new Intl.DisplayNames([lang], { type: "region" });
    } catch {
      displayNames[lang] = null;
    }
  }
  return displayNames[lang] ?? null;
}

/** Landesname in der Belegsprache (de: wie `countryNameDe`; en: z. B. "Austria"); null bei ungueltigem Code. */
export function countryName(code: string | null | undefined, lang: DocLanguage = "de"): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  const name = getDisplayNames(lang)?.of(c);
  return name && name !== c ? name : c;
}

/** Deutscher Landesname (z. B. "Australien", "Österreich"); null bei ungueltigem Code. */
export function countryNameDe(code: string | null | undefined): string | null {
  return countryName(code, "de");
}

/**
 * Letzte Anschriftszeile "LANDESNAME" (Grossbuchstaben), auch fuer Inlandsanschriften;
 * null nur, wenn das Land fehlt oder ungueltig ist.
 */
export function addressCountryLine(countryCode: string | null | undefined, lang: DocLanguage = "de"): string | null {
  const name = countryName(countryCode, lang);
  return name ? name.toLocaleUpperCase(lang === "en" ? "en-GB" : "de-DE") : null;
}
