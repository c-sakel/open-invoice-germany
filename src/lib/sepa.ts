/**
 * SEPA-Glaeubiger-ID und Mandatsreferenz (BT-90, BT-89).
 *
 * Quelle: EPC-Rulebook (SEPA Core Direct Debit), Struktur der Glaeubiger-ID:
 * Laenderkennung (2), Pruefziffern (2), Geschaeftsbereichskennung (3), laenderspezifische
 * Kennung. Die Pruefziffer wird MOD 97-10 ueber die Id OHNE Geschaeftsbereich
 * (Stellen 5-7) berechnet. Deutschland: 18 Zeichen, Kennung 11 Ziffern.
 */

/** Leerzeichen raus, Grossbuchstaben. */
export function normalizeCreditorId(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

const CREDITOR_ID_FORMAT = /^[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28}$/;

/** Prueft eine bereits normalisierte Glaeubiger-ID (Format, DE-Laenge, Pruefziffer). */
export function isValidCreditorId(ci: string): boolean {
  if (ci.length > 35 || !CREDITOR_ID_FORMAT.test(ci)) return false;
  if (ci.startsWith("DE") && !/^DE\d{2}[A-Z0-9]{3}\d{11}$/.test(ci)) return false;
  const rearranged = ci.slice(7) + ci.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  return remainder === 1;
}

/** Zeichensatz der Mandatsreferenz nach EPC-Rulebook, 1-35 Zeichen. */
export const MANDATE_REFERENCE_PATTERN = /^[A-Za-z0-9+?/\-:().,']{1,35}$/;

export function isValidMandateReference(ref: string): boolean {
  return MANDATE_REFERENCE_PATTERN.test(ref);
}
