/**
 * IBAN-Normalisierung und -Prüfung nach ISO 13616 / ISO 7064 (MOD 97-10).
 *
 * Eine IBAN in der E-Rechnung (BT-84) muss ohne Leerzeichen und in
 * Großbuchstaben stehen. Die Prüfsumme fängt Zahlendreher ab, die eine
 * reine Formatprüfung durchlässt.
 */

/** Entfernt Leerzeichen und vereinheitlicht auf Großbuchstaben. */
export function normalizeIban(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

const IBAN_FORMAT = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

/** Prüft Format und MOD-97-10-Prüfsumme einer bereits normalisierten IBAN. */
export function isValidIban(iban: string): boolean {
  if (!IBAN_FORMAT.test(iban)) return false;
  // Die ersten vier Zeichen (Ländercode + Prüfziffern) wandern ans Ende,
  // Buchstaben werden zu Zahlen (A=10 … Z=35). Rest bei 97 muss 1 sein.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const d of digits) {
    remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}
