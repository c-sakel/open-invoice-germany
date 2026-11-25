import { describe, it, expect } from "vitest";
import { buildEInvoiceData, type MapInput } from "@/lib/einvoice/mapper";

const EN = "Notice pursuant to § 286 (3) German Civil Code (BGB): you will be in default at the latest if payment is not made within 30 days after the due date and receipt of this invoice.";

function input(over: Partial<MapInput> = {}): MapInput {
  return {
    number: "RE-2231-0001", type: "INVOICE", status: "FINALIZED", issueDate: new Date("2231-03-01"), dueDate: new Date("2231-03-31"),
    currency: "EUR", language: "de", netTotalCents: 10000, taxTotalCents: 1900, grossTotalCents: 11900, paidAmountCents: 0,
    taxBreakdownJson: JSON.stringify([{ taxRate: 19, taxCategory: "S", baseNetCents: 10000, taxCents: 1900, allowanceCents: 0, chargeCents: 0 }]),
    org: { legalName: "Test GmbH", addressLine1: "Hauptstr. 1", addressLine2: null, postalCode: "21339", city: "Lüneburg", country: "DE", vatId: "DE123456789", taxNumber: null, email: null, phone: null, electronicAddress: null, iban: null },
    customer: { name: "Privat", addressLine1: "Weg 1", addressLine2: null, postalCode: "20095", city: "Hamburg", country: "DE", countryCode: "DE", vatId: null, email: null, type: "CONSUMER" },
    lines: [{ id: "1", position: 1, description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, lineNetCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, lineType: "ITEM" }],
    ...over,
  } as unknown as MapInput;
}

describe("Mapper: Verzugshinweis (BT-20)", () => {
  it("de: Satz steht allein, wenn keine weiteren Zahlungsbedingungen existieren", () => {
    const d = buildEInvoiceData(input({ consumerDefaultNotice: true, paymentTerms: null }));
    expect(d.consumerDefaultNotice).toBe(true);
    expect(d.paymentTermsNote).toContain("§ 286 Abs. 3 BGB");
    expect(d.paymentTermsNote?.includes("\n")).toBe(false);
  });

  it("haengt den Satz als letzte Zeile hinter Menschentext und Skonto an", () => {
    const d = buildEInvoiceData(input({ consumerDefaultNotice: true, paymentTerms: "Zahlbar in 30 Tagen.", skonto1Permille: 20, skonto1Days: 10 }));
    const lines = (d.paymentTermsNote ?? "").split("\n");
    expect(lines.at(-1)).toContain("§ 286 Abs. 3 BGB");
    expect(lines.slice(0, -1).some((l) => l.startsWith("#SKONTO#"))).toBe(true);
    expect(lines.filter((l) => l.startsWith("#") && l.includes("286"))).toHaveLength(0);
  });

  it("englischer Beleg -> englischer Satz", () => {
    const d = buildEInvoiceData(input({ consumerDefaultNotice: true, language: "en" }));
    expect(d.paymentTermsNote?.split("\n").at(-1)).toBe(EN);
  });

  it("Gutschrift -> nie", () => {
    const d = buildEInvoiceData(input({ consumerDefaultNotice: true, type: "CREDIT_NOTE" }));
    expect(d.consumerDefaultNotice).toBeUndefined();
    expect(d.paymentTermsNote ?? "").not.toContain("286");
  });

  it("ohne Kennzeichen (undefined/null/false) identisch zum Stand davor", () => {
    const base = buildEInvoiceData(input({ paymentTerms: "Zahlbar in 30 Tagen." }));
    for (const v of [undefined, null, false] as const) {
      expect(buildEInvoiceData(input({ paymentTerms: "Zahlbar in 30 Tagen.", consumerDefaultNotice: v }))).toEqual(base);
    }
    expect("consumerDefaultNotice" in base).toBe(false);
  });
});

describe("Mapper: Skonto bei Gutschrift/Storno (kein BASISBETRAG)", () => {
  it("Gutschrift mit Skonto-Feldern: kein BASISBETRAG, keine Ausnahme", () => {
    const d = buildEInvoiceData(input({ type: "CREDIT_NOTE", grossTotalCents: 11900, skonto1Permille: 20, skonto1Days: 10, paymentTerms: "Zahlbar in 30 Tagen." }));
    expect(d.paymentTermsNote ?? "").not.toContain("BASISBETRAG");
  });
  it("Storno (negativer Betrag) mit Skonto: kein BASISBETRAG", () => {
    const d = buildEInvoiceData(input({ type: "CANCELLATION", grossTotalCents: -11900, netTotalCents: -10000, taxTotalCents: -1900, skonto1Permille: 20, skonto1Days: 10, paymentTerms: "Zahlbar in 30 Tagen." }));
    expect(d.paymentTermsNote ?? "").not.toContain("BASISBETRAG");
  });
});
