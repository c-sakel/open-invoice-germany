/**
 * Laendernamen fuer Anschriftszeilen (DIN 5008 / Weltpostverein): Landesname deutsch in
 * Grossbuchstaben als letzte Zeile, aber nur bei Auslandsanschriften (Empfaengerland !=
 * Absenderland). Quelle der Namen: Intl.DisplayNames("de") (ICU, im Node-Image enthalten —
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
 * Letzte Anschriftszeile "LANDESNAME" (Grossbuchstaben) oder null, wenn das Land fehlt
 * bzw. dem Absenderland entspricht (Inland — kein Landeszusatz).
 */
export function foreignCountryLine(
  countryCode: string | null | undefined,
  senderCountryCode: string | null | undefined,
): string | null {
  const c = (countryCode ?? "").trim().toUpperCase();
  const s = (senderCountryCode ?? "DE").trim().toUpperCase() || "DE";
  if (!c || c === s) return null;
  const name = countryNameDe(c);
  return name ? name.toLocaleUpperCase("de-DE") : null;
}
