/**
 * Laendernamen fuer Anschriftszeilen: Landesname deutsch in Grossbuchstaben als letzte Zeile,
 * auf Betreiber-Wunsch (2026-10-09) bei JEDER Anschrift, auch im Inland. Quelle der Namen: Intl.DisplayNames("de") (ICU, im Node-Image enthalten —
 * Node >= 13 liefert full-icu); fehlt ein Name, wird der ISO-Code selbst gedruckt.
 */

let displayNames: Intl.DisplayNames | null | undefined;

function getDisplayNames(): Intl.DisplayNames | null {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["de"], { type: "region" });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
}

/** Deutscher Landesname (z. B. "Australien", "Österreich"); null bei ungueltigem Code. */
export function countryNameDe(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return null;
  const name = getDisplayNames()?.of(c);
  return name && name !== c ? name : c;
}

/**
 * Letzte Anschriftszeile "LANDESNAME" (Grossbuchstaben), auch fuer Inlandsanschriften;
 * null nur, wenn das Land fehlt oder ungueltig ist.
 */
export function addressCountryLine(countryCode: string | null | undefined): string | null {
  const name = countryNameDe(countryCode);
  return name ? name.toLocaleUpperCase("de-DE") : null;
}
