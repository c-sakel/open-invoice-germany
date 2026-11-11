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
    fxRateMicros: null, fxRateDate: null, fxRateSource: null, fxOverrideMicros: null, taxTotalEurCents: 1900, netTotalEurCents: 10000, language: "de",
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

describe("serializeInvoice: Fremdwaehrung und Sprache (Phase 16b)", () => {
  it("EUR-Beleg: Kursfelder null, EUR-Summen gesetzt, Sprache", () => {
    const out = serializeInvoice(inv({}), new Set());
    expect(out.fxRate).toBeNull();
    expect(out.fxRateDate).toBeNull();
    expect(out.fxRateSource).toBeNull();
    expect(out.fxOverrideRate).toBeNull();
    expect(out.taxTotalEurCents).toBe(1900);
    expect(out.netTotalEurCents).toBe(10000);
    expect(out.language).toBe("de");
    expect(() => invoiceSchema.strict().parse(out)).not.toThrow();
  });

  it("USD-Beleg: Kurs als Dezimalstring mit Punkt, Kursdatum ISO, Override", () => {
    const out = serializeInvoice(
      inv({
        currency: "USD", fxRateMicros: 1121400, fxRateDate: new Date("2109-03-01T00:00:00Z"), fxRateSource: "BMF_MONTHLY",
        fxOverrideMicros: 1250000, language: "en",
      }),
      new Set(),
    );
    expect(out.fxRate).toBe("1.1214");
    expect(out.fxRateDate).toBe("2109-03-01T00:00:00.000Z");
    expect(out.fxRateSource).toBe("BMF_MONTHLY");
    expect(out.fxOverrideRate).toBe("1.2500");
    expect(out.language).toBe("en");
    expect(() => invoiceSchema.strict().parse(out)).not.toThrow();
  });
});
