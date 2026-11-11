/**
 * Belegstrecke einer Rechnung (Phase 16f): reine Ableitung der Stufenleiste
 * Entwurf -> Festgeschrieben -> Versendet -> Teilbezahlt -> Bezahlt aus Status, Versandmerkmal
 * und Zahlstand. Eine Luecke vor dem erreichten Schritt ist nie "todo" (z. B. PAID ohne
 * Versand: Versendet gilt als erledigt).
 */
export type BelegStepKey = "DRAFT" | "FINALIZED" | "SENT" | "PARTIALLY_PAID" | "PAID" | "CANCELLED";

export interface BelegStep {
  key: BelegStepKey;
  label: string;
  state: "done" | "current" | "todo";
  /** Festgeschrieben-Schritt, sobald der Beleg festgeschrieben ist (Stempel-Optik). */
  stamp: boolean;
}

export interface BelegStreckeInput {
  status: string;
  sent: boolean;
  paidAmountCents: number;
  payableCents: number;
}

const ORDER: { key: Exclude<BelegStepKey, "CANCELLED">; label: string }[] = [
  { key: "DRAFT", label: "Entwurf" },
  { key: "FINALIZED", label: "Festgeschrieben" },
  { key: "SENT", label: "Versendet" },
  { key: "PARTIALLY_PAID", label: "Teilbezahlt" },
  { key: "PAID", label: "Bezahlt" },
];

const IDX = { DRAFT: 0, FINALIZED: 1, SENT: 2, PARTIALLY_PAID: 3, PAID: 4 } as const;

/** Index des zuletzt erreichten Schritts (ohne Storno-Sonderfall). */
function reachedIndex(inv: BelegStreckeInput): number {
  switch (inv.status) {
    case "DRAFT":
      return IDX.DRAFT;
    case "SENT":
      return IDX.SENT;
    case "PARTIALLY_PAID":
      return IDX.PARTIALLY_PAID;
    case "PAID":
      return IDX.PAID;
    case "CANCELLED": {
      if (inv.payableCents > 0 && inv.paidAmountCents >= inv.payableCents) return IDX.PAID;
      if (inv.paidAmountCents > 0) return IDX.PARTIALLY_PAID;
      return inv.sent ? IDX.SENT : IDX.FINALIZED;
    }
    // FINALIZED sowie wirksame Status OPEN/DUE/OVERDUE (nur Anzeige).
    default:
      return inv.sent ? IDX.SENT : IDX.FINALIZED;
  }
}

export function belegStrecke(inv: BelegStreckeInput): BelegStep[] {
  const reached = reachedIndex(inv);
  const finalized = inv.status !== "DRAFT";

  if (inv.status === "CANCELLED") {
    const done: BelegStep[] = ORDER.slice(0, reached + 1).map((s) => ({
      key: s.key,
      label: s.label,
      state: "done",
      stamp: s.key === "FINALIZED",
    }));
    return [...done, { key: "CANCELLED", label: "Storniert", state: "current", stamp: false }];
  }

  return ORDER.map((s, i) => ({
    key: s.key,
    label: s.label,
    state: i < reached ? "done" : i === reached ? "current" : "todo",
    stamp: s.key === "FINALIZED" && finalized,
  }));
}
