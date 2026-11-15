/**
 * Abgleich eines Bezahlvorgangs mit dem Zustand beim Anbieter (rein, ohne Datenbank). Das Ergebnis
 * beschreibt nur, was zu tun ist; gebucht wird in `reconcile.ts` ausschliesslich ueber die
 * Zahlungs-Domaenenfunktionen.
 */
import type { ProviderPaymentState } from "@/lib/payment/types";

export type AttemptStatus = "CREATING" | "OPEN" | "PAID" | "EXPIRED" | "CANCELED" | "FAILED";

export interface ReconcileInput {
  state: ProviderPaymentState;
  accountTestMode: boolean;
  attempt: { id: string; amountCents: number; currency: string };
  /** Bereits gebuchte Zahlung zu diesem Vorgang samt Summe ihrer Gegenbuchungen (positiv). */
  booked: { paymentId: string; amountCents: number; reversedCents: number } | null;
  invoice: { status: string; openCents: number };
  /** refunded + chargedBack des juengsten APPLIED/TEST-Ereignisses dieses Vorgangs. */
  previousProviderCents: number | null;
  /** Erstattungsanteil (refunded) desselben Ereignisses. */
  previousRefundedCents: number | null;
  /** Zur Rechnung existiert eine Gutschrift/Teilgutschrift: Erstattungen werden dann nicht automatisch gegengebucht. */
  hasCreditNote: boolean;
}

export interface ReconcilePlan {
  /** null = Vorgangsstatus unveraendert. */
  attemptStatus: AttemptStatus | null;
  result: "APPLIED" | "IGNORED" | "ERROR" | "TEST";
  book: number | null;
  overpaidCents: number;
  unassigned: null | "NOTHING_OPEN" | "CANCELLED";
  reverse: { cents: number; reason: string } | null;
  review: null | "REVERSAL_DECREASED" | "MISMATCH" | "MODE_MISMATCH" | "REFUND_WITH_CREDIT_NOTE";
  /** Erstattung beim Anbieter trotz Gutschrift (kumuliert, in Cent); nur mit review REFUND_WITH_CREDIT_NOTE. */
  refundNoticeCents: number;
  /** Zuwachs bei Erstattung/Rueckbuchung beim Anbieter, der durch eine manuelle Gegenbuchung bereits gedeckt ist (Cent); nur Protokoll, keine Buchung. */
  coveredByManualCents: number;
}

export function eventIdFor(s: ProviderPaymentState): string {
  return `${s.objectId}:${s.status}:${s.refundedCents}:${s.chargedBackCents}`;
}

/** Liest refunded + chargedBack aus einer Ereignis-Id (`objekt:status:refunded:chargedBack`). */
export function providerCentsFromEventId(eventId: string): number | null {
  const s = providerSplitFromEventId(eventId);
  return s ? s.refunded + s.chargedBack : null;
}

export function providerSplitFromEventId(eventId: string): { refunded: number; chargedBack: number } | null {
  const m = /:(\d+):(\d+)$/.exec(eventId.replace(/#(err-|r\d).*$/, ""));
  return m ? { refunded: Number(m[1]), chargedBack: Number(m[2]) } : null;
}

function statusFor(s: ProviderPaymentState["status"]): AttemptStatus | null {
  switch (s) {
    case "PAID":
      return "PAID";
    case "OPEN":
      return "OPEN";
    case "EXPIRED":
      return "EXPIRED";
    case "CANCELED":
      return "CANCELED";
    case "FAILED":
      return "FAILED";
    case "UNKNOWN":
      return null;
  }
}

const REASON_REFUND = "Erstattung beim Zahlungsanbieter";
const REASON_CHARGEBACK = "Rueckbuchung beim Zahlungsanbieter (Chargeback)";
const REASON_BOTH = "Erstattung und Rueckbuchung beim Zahlungsanbieter (Chargeback)";

export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const { state, attempt, booked, invoice } = input;
  const base: ReconcilePlan = { attemptStatus: statusFor(state.status), result: "IGNORED", book: null, overpaidCents: 0, unassigned: null, reverse: null, review: null, refundNoticeCents: 0, coveredByManualCents: 0 };

  if (state.testMode !== input.accountTestMode) return { ...base, attemptStatus: null, result: "ERROR", review: "MODE_MISMATCH" };
  if (
    state.amountCents !== attempt.amountCents ||
    state.currency !== attempt.currency ||
    (state.attemptId !== null && state.attemptId !== attempt.id)
  ) {
    return { ...base, attemptStatus: null, result: "ERROR", review: "MISMATCH" };
  }
  // Testmodus: Status wird gepflegt, gebucht wird nie.
  if (input.accountTestMode) return { ...base, result: "TEST" };
  if (state.status !== "PAID") return base;

  const plan: ReconcilePlan = { ...base };
  let bookedCents = booked?.amountCents ?? 0;
  if (!booked) {
    if (invoice.status === "CANCELLED") {
      plan.unassigned = "CANCELLED";
    } else if (invoice.status === "DRAFT" || invoice.openCents <= 0) {
      plan.unassigned = "NOTHING_OPEN";
    } else {
      const book = Math.min(state.amountCents, invoice.openCents);
      plan.book = book;
      plan.overpaidCents = state.amountCents - book;
      plan.result = "APPLIED";
      bookedCents = book;
    }
  }

  const providerCents = state.refundedCents + state.chargedBackCents;
  if (input.previousProviderCents !== null && providerCents < input.previousProviderCents) {
    plan.review = "REVERSAL_DECREASED";
    return plan;
  }
  // Mit Gutschrift zur Rechnung ist der Erstattungsanteil dort schon erledigt: nur Rueckbuchungen werden gegengebucht,
  // Erstattungen nur gemeldet (einmal je Erhoehung).
  const autoCents = input.hasCreditNote ? state.chargedBackCents : providerCents;
  if (input.hasCreditNote && state.refundedCents > 0 && state.refundedCents > (input.previousRefundedCents ?? 0)) {
    plan.review = "REFUND_WITH_CREDIT_NOTE";
    plan.refundNoticeCents = state.refundedCents;
    plan.result = "APPLIED";
  }
  // Erstattungen werden zuerst gegen nicht gebuchte Anteile (Ueberzahlung, nicht zugeordnet) gerechnet.
  const unbooked = state.amountCents - bookedCents;
  const target = Math.min(Math.max(autoCents - unbooked, 0), bookedCents);
  const alreadyReversed = booked?.reversedCents ?? 0;
  if (target > alreadyReversed) {
    const reason = state.refundedCents > 0 && state.chargedBackCents > 0 ? REASON_BOTH : state.chargedBackCents > 0 ? REASON_CHARGEBACK : REASON_REFUND;
    plan.reverse = { cents: target - alreadyReversed, reason };
    plan.result = "APPLIED";
  } else if (target > 0 && providerCents > (input.previousProviderCents ?? 0)) {
    // Gemeldet wird der Zuwachs dieses Ereignisses (nicht der kumulative Zielwert).
    plan.coveredByManualCents = Math.min(target, providerCents - (input.previousProviderCents ?? 0));
  }
  return plan;
}
