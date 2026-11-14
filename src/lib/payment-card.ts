/**
 * Gekuerzte Kartennummer (BT-87) und Kartennetz.
 *
 * Quelle: EN 16931 BR-51 (nur die letzten 4-6 Ziffern) und PCI DSS 3.4: die volle
 * Kartennummer (PAN) wird nie erfasst oder gespeichert. Eingaben mit mehr als
 * 10 Ziffern werden abgelehnt; die Meldung enthaelt nie den Eingabewert.
 */

export const CARD_NETWORK_SUGGESTIONS: readonly string[] = [
  "VISA", "MASTERCARD", "AMEX", "GIROCARD", "MAESTRO", "VPAY", "DINERS", "JCB", "UNIONPAY",
];

export const CARD_NETWORK_PATTERN = /^[A-Za-z0-9 ._-]{1,35}$/;

export type PanInputResult =
  | { ok: true; last4: string }
  | { ok: false; reason: "zu-lang" | "zu-kurz" | "zeichen" };

/** Entfernt Trenner/Maskierung, verlangt 4-10 Ziffern und liefert die letzten 4. */
export function truncatePanInput(raw: string): PanInputResult {
  const stripped = raw.replace(/[\s*xX.\-]/g, "");
  if (!/^\d*$/.test(stripped)) return { ok: false, reason: "zeichen" };
  if (stripped.length > 10) return { ok: false, reason: "zu-lang" };
  if (stripped.length < 4) return { ok: false, reason: "zu-kurz" };
  return { ok: true, last4: stripped.slice(-4) };
}
