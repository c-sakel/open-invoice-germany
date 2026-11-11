/**
 * Status einer Rechnung nach einer Gegenbuchung (Phase 16a). Rein, ohne DB:
 * eine stornierte Rechnung bleibt storniert; sonst bestimmt der verbleibende Zahlbetrag den Status,
 * bei null bezahlten Cent entscheidet, ob der Beleg bereits ausgegeben (versendet) wurde.
 */
export type StatusAfterReversal = "CANCELLED" | "PAID" | "PARTIALLY_PAID" | "SENT" | "FINALIZED";

export function deriveStatusAfterReversal(i: {
  status: string;
  paidCents: number;
  baseCents: number;
  hasOutput: boolean;
}): StatusAfterReversal {
  if (i.status === "CANCELLED") return "CANCELLED";
  if (i.paidCents >= i.baseCents) return "PAID";
  if (i.paidCents > 0) return "PARTIALLY_PAID";
  return i.hasOutput ? "SENT" : "FINALIZED";
}
