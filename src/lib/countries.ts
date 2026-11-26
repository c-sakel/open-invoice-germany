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

/** ISO 3166-1 alpha-2 (zugewiesene Codes) fuer die Laenderauswahl in Formularen. */
export const COUNTRY_CODES: readonly string[] =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" ");

export type CountryOption = { id: string; label: string; subtitle: string };

/**
 * Optionen fuer `SearchSelect`: deutscher Name (Label), ISO-2 (Untertitel, ebenfalls durchsuchbar), nach Name sortiert.
 * Ein Bestandswert ausserhalb der Liste (z. B. Altdaten) wird angehaengt und bleibt so sichtbar und erhalten.
 */
export function countryOptions(extraCode?: string | null): CountryOption[] {
  const list = COUNTRY_CODES.map((id) => ({ id, label: countryNameDe(id) ?? id, subtitle: id }));
  list.sort((a, b) => a.label.localeCompare(b.label, "de"));
  const extra = (extraCode ?? "").trim();
  if (extra !== "" && !COUNTRY_CODES.includes(extra)) list.push({ id: extra, label: extra, subtitle: "Bestandswert" });
  return list;
}
