import { describe, it, expect } from "vitest";
import { serializeInvoice, invoiceSchema, type InvoiceWithOptionalRelations } from "@/api/serializers/invoice";

function inv(over: Partial<InvoiceWithOptionalRelations>): InvoiceWithOptionalRelations {
  return {
    id: "i1", number: "RE-1", status: "FINALIZED", type: "INVOICE", taxScheme: "REGULAR", customerId: "c1",
    contactPersonId: null, billingAddressId: null, shippingAddressId: null, currency: "EUR",
    issueDate: null, deliveryDate: null, deliveryStart: null, deliveryEnd: null, dueDate: null,
    buyerReference: null, subject: null, orderNumber: null, notes: null, paymentTerms: null, headerText: null, footerText: null,
    documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0, documentChargeReason: null,
    skonto1Permille: null, skonto1Days: null, skonto2Permille: null, skonto2Days: null, paymentMethodId: null,
    netTotalCents: 10000, taxTotalCents: 1900, grossTotalCents: 11900, paidAmountCents: 0, payableCents: null, prepaidCents: 0,
    reversedByInvoiceId: null, correctsInvoiceId: null, recurringInvoiceId: null, sourceType: null, sourceId: null,
    partialPermille: null, xmlFormat: null, finalizedAt: null, dunningState: "NONE", dunningPausedUntil: null, dunningStateNote: null,
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as InvoiceWithOptionalRelations;
}

describe("serializeInvoice: Komfortfelder payableTotalCents/openAmountCents", () => {
  it("normaler Beleg: payableCents null -> payableTotalCents = brutto", () => {
    const out = serializeInvoice(inv({ paidAmountCents: 4000 }), new Set());
    expect(out.payableCents).toBeNull();
    expect(out.payableTotalCents).toBe(11900);
    expect(out.openAmountCents).toBe(7900);
    expect(() => invoiceSchema.strict().parse(out)).not.toThrow();
  });

  it("Abschlagsrechnung: payableCents gesetzt -> payableTotalCents = payableCents", () => {
    const out = serializeInvoice(inv({ type: "DOWNPAYMENT", payableCents: 5000, paidAmountCents: 1000 }), new Set());
    expect(out.payableCents).toBe(5000);
    expect(out.payableTotalCents).toBe(5000);
    expect(out.openAmountCents).toBe(4000);
  });

  it("Ueberzahlung: openAmountCents nie negativ", () => {
    expect(serializeInvoice(inv({ paidAmountCents: 20000 }), new Set()).openAmountCents).toBe(0);
  });
});
