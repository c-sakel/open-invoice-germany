import { describe, expect, it } from "vitest";
import { eventIdFor, planReconcile, providerCentsFromEventId, type ReconcileInput } from "@/domain/online-payment/reconcile-plan";
import type { ProviderPaymentState } from "@/lib/payment/types";

const state = (o: Partial<ProviderPaymentState> = {}): ProviderPaymentState => ({
  objectId: "tr_Plan0001",
  paymentRef: null,
  testMode: false,
  status: "PAID",
  amountCents: 11900,
  currency: "EUR",
  refundedCents: 0,
  chargedBackCents: 0,
  paidAt: new Date("2216-03-10T10:00:00Z"),
  expiresAt: null,
  attemptId: "att1",
  ...o,
});

const input = (o: Partial<ReconcileInput> = {}): ReconcileInput => ({
  state: state(),
  accountTestMode: false,
  attempt: { id: "att1", amountCents: 11900, currency: "EUR" },
  booked: null,
  invoice: { status: "FINALIZED", openCents: 11900 },
  previousProviderCents: null,
  previousRefundedCents: null,
  hasCreditNote: false,
  ...o,
});

describe("planReconcile", () => {
  it("Erstattung bereits durch manuelle Gegenbuchung gedeckt: keine Buchung, coveredByManualCents", () => {
    const booked = { paymentId: "p1", amountCents: 11900, reversedCents: 1900 };
    const p = planReconcile(input({ booked, state: state({ refundedCents: 1900 }) }));
    expect(p).toMatchObject({ reverse: null, coveredByManualCents: 1900, result: "IGNORED" });
    const more = planReconcile(input({ booked, state: state({ refundedCents: 5000 }) }));
    expect(more).toMatchObject({ reverse: { cents: 3100 }, coveredByManualCents: 0 });
    const unchanged = planReconcile(input({ booked, previousProviderCents: 1900, previousRefundedCents: 1900, state: state({ refundedCents: 1900 }) }));
    expect(unchanged.coveredByManualCents).toBe(0);
  });

  it("bezahlt und noch nicht gebucht: voller Betrag, keine Ueberzahlung", () => {
    const p = planReconcile(input());
    expect(p).toMatchObject({ result: "APPLIED", book: 11900, overpaidCents: 0, attemptStatus: "PAID", reverse: null, unassigned: null });
  });

  it("offener Rest kleiner als Zahlung: bis zum Rest, Ueberzahlung gemeldet", () => {
    const p = planReconcile(input({ invoice: { status: "PARTIALLY_PAID", openCents: 5000 } }));
    expect(p).toMatchObject({ book: 5000, overpaidCents: 6900, result: "APPLIED" });
  });

  it("nichts offen oder storniert: nicht buchen", () => {
    expect(planReconcile(input({ invoice: { status: "PAID", openCents: 0 } }))).toMatchObject({ book: null, unassigned: "NOTHING_OPEN", attemptStatus: "PAID" });
    expect(planReconcile(input({ invoice: { status: "CANCELLED", openCents: 11900 } }))).toMatchObject({ book: null, unassigned: "CANCELLED" });
  });

  it("Erstattung bei vorhandener Gutschrift: keine Gegenbuchung, einmal melden; Rueckbuchung weiter automatisch", () => {
    const booked = { paymentId: "p1", amountCents: 11900, reversedCents: 0 };
    const p = planReconcile(input({ booked, hasCreditNote: true, state: state({ refundedCents: 3000 }) }));
    expect(p).toMatchObject({ reverse: null, review: "REFUND_WITH_CREDIT_NOTE", refundNoticeCents: 3000, result: "APPLIED" });
    const again = planReconcile(input({ booked, hasCreditNote: true, previousRefundedCents: 3000, previousProviderCents: 3000, state: state({ refundedCents: 3000 }) }));
    expect(again).toMatchObject({ reverse: null, review: null });
    const cb = planReconcile(input({ booked, hasCreditNote: true, state: state({ refundedCents: 3000, chargedBackCents: 2000 }) }));
    expect(cb.reverse?.cents).toBe(2000);
  });

  it("Buchung und Erstattung im selben Abruf", () => {
    const p = planReconcile(input({ state: state({ refundedCents: 1900 }) }));
    expect(p).toMatchObject({ book: 11900, reverse: { cents: 1900, reason: "Erstattung beim Zahlungsanbieter" } });
  });

  it("Ueberzahlung plus spaetere Erstattung nur des Ueberschusses: keine Gegenbuchung", () => {
    const booked = { paymentId: "p1", amountCents: 5000, reversedCents: 0 };
    const inv = { status: "PAID", openCents: 0 };
    expect(planReconcile(input({ booked, invoice: inv, state: state({ refundedCents: 6900 }), previousProviderCents: 0 })).reverse).toBeNull();
    // Erstattung ueber den Ueberschuss hinaus: nur der Mehrbetrag wird gegengebucht.
    expect(planReconcile(input({ booked, invoice: inv, state: state({ refundedCents: 8900 }), previousProviderCents: 6900 })).reverse).toMatchObject({ cents: 2000 });
  });

  it("Chargeback voll und kumulativ", () => {
    const booked = { paymentId: "p1", amountCents: 11900, reversedCents: 0 };
    const p = planReconcile(input({ booked, invoice: { status: "PAID", openCents: 0 }, state: state({ chargedBackCents: 11900 }) }));
    expect(p.reverse).toEqual({ cents: 11900, reason: "Rueckbuchung beim Zahlungsanbieter (Chargeback)" });
    const both = planReconcile(input({ booked, invoice: { status: "PAID", openCents: 0 }, state: state({ refundedCents: 1000, chargedBackCents: 2000 }) }));
    expect(both.reverse).toMatchObject({ cents: 3000 });
    expect(both.reverse?.reason).toContain("Erstattung und Rueckbuchung");
  });

  it("Erstattung nach manueller Gegenbuchung: nichts doppelt", () => {
    const booked = { paymentId: "p1", amountCents: 11900, reversedCents: 5000 };
    const same = planReconcile(input({ booked, invoice: { status: "PARTIALLY_PAID", openCents: 5000 }, state: state({ refundedCents: 5000 }) }));
    expect(same.reverse).toBeNull();
    const more = planReconcile(input({ booked, invoice: { status: "PARTIALLY_PAID", openCents: 5000 }, state: state({ refundedCents: 7000 }) }));
    expect(more.reverse).toMatchObject({ cents: 2000 });
  });

  it("sinkende Summe beim Anbieter: nur pruefen, nichts buchen", () => {
    const booked = { paymentId: "p1", amountCents: 11900, reversedCents: 1900 };
    const p = planReconcile(input({ booked, invoice: { status: "PARTIALLY_PAID", openCents: 1900 }, state: state({ refundedCents: 500 }), previousProviderCents: 1900 }));
    expect(p).toMatchObject({ review: "REVERSAL_DECREASED", reverse: null });
  });

  it("Testmodus bucht nie", () => {
    const p = planReconcile(input({ accountTestMode: true, state: state({ testMode: true }) }));
    expect(p).toMatchObject({ result: "TEST", book: null, reverse: null, attemptStatus: "PAID" });
    expect(planReconcile(input({ accountTestMode: true, state: state({ testMode: true, refundedCents: 100 }) })).reverse).toBeNull();
  });

  it("Modus-, Betrag-, Waehrung- und Vorgangs-Abweichung: Fehler, nichts buchen", () => {
    expect(planReconcile(input({ state: state({ testMode: true }) }))).toMatchObject({ result: "ERROR", review: "MODE_MISMATCH", book: null });
    expect(planReconcile(input({ state: state({ amountCents: 100 }) }))).toMatchObject({ result: "ERROR", review: "MISMATCH", book: null });
    expect(planReconcile(input({ state: state({ currency: "USD" }) }))).toMatchObject({ result: "ERROR", review: "MISMATCH" });
    expect(planReconcile(input({ state: state({ attemptId: "fremd" }) }))).toMatchObject({ result: "ERROR", review: "MISMATCH" });
  });

  it("nicht bezahlt: nur Status des Vorgangs", () => {
    expect(planReconcile(input({ state: state({ status: "EXPIRED" }) }))).toMatchObject({ attemptStatus: "EXPIRED", result: "IGNORED", book: null });
    expect(planReconcile(input({ state: state({ status: "CANCELED" }) })).attemptStatus).toBe("CANCELED");
    expect(planReconcile(input({ state: state({ status: "UNKNOWN" }) })).attemptStatus).toBeNull();
  });
});

describe("Ereignis-Id", () => {
  it("setzt sich aus Objekt, Status und Summen zusammen und ist zurueck lesbar", () => {
    const id = eventIdFor(state({ refundedCents: 100, chargedBackCents: 250 }));
    expect(id).toBe("tr_Plan0001:PAID:100:250");
    expect(providerCentsFromEventId(id)).toBe(350);
    expect(providerCentsFromEventId(`${id}#err-abc`)).toBe(350);
    expect(providerCentsFromEventId("quatsch")).toBeNull();
  });
});
