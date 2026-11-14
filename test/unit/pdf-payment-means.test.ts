/**
 * Phase 18e, Task 6 — PDF: Lastschrift-Vorabankuendigung, Kartenhinweis, GiroCode-Unterdrueckung
 * (Testjahr 2183, ohne DB).
 */
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { paymentMeansPdfText } from "@/lib/pdf/payment-means-text";
import { testPdfTheme, parsePdf } from "../helpers/pdf-theme";
import type { EInvoiceData } from "@/lib/einvoice/types";

const DEBTOR_IBAN = "DE02120300000000202051";
const directDebit = {
  creditorId: "DE98ZZZ09999999999",
  mandateReference: "MANDAT-2183-001",
  mandateSignedAt: "2183-01-05",
  debtorIban: DEBTOR_IBAN,
  debtorAccountName: "Kunde Muster",
};

function invoice(paymentMeans: EInvoiceData["paymentMeans"], extra: Partial<EInvoiceData> = {}): EInvoiceData {
  return {
    number: "RE-2183-00001",
    type: "INVOICE",
    issueDate: new Date("2183-03-12T10:00:00Z"),
    dueDate: new Date("2183-03-26T10:00:00Z"),
    currency: "EUR",
    seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin", countryCode: "DE", vatId: "DE123456789", phone: "030 1", email: "a@b.de" },
    buyer: { name: "Kunde Muster", addressLine1: "Weg 2", postalCode: "10001", city: "Berlin", countryCode: "DE", customerNumber: "K-1" },
    lines: [{ id: "1", description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, lineNetCents: 10000, taxRate: 19, taxCategory: "S", lineType: "ITEM" }],
    taxSubtotals: [{ taxRate: 19, taxCategory: "S", netCents: 10000, taxCents: 1900 }],
    netTotalCents: 10000,
    taxTotalCents: 1900,
    grossTotalCents: 11900,
    payableCents: 11900,
    giroAmountCents: 11900,
    iban: "DE12500105170648489890",
    paymentMeans,
    ...extra,
  };
}

const flat = (s: string): string => s.replace(/\s+/g, " ");

describe("paymentMeansPdfText", () => {
  const base = { payableCents: 11900, currency: "EUR", dueDate: new Date("2183-03-26T10:00:00Z") };
  it("Lastschrift de mit Faelligkeit, IBAN maskiert", () => {
    const text = paymentMeansPdfText({ ...base, paymentMeans: { code: "59", directDebit } }, "de");
    expect(text).toBe(
      "Den Betrag von 119,00\u00a0€ ziehen wir am 26.03.2183 per SEPA-Lastschrift von Ihrem Konto DE02 **** 2051 ein. Mandatsreferenz: MANDAT-2183-001, Gläubiger-ID: DE98ZZZ09999999999.",
    );
    expect(text).not.toContain(DEBTOR_IBAN);
  });
  it("Lastschrift ohne Faelligkeit de/en", () => {
    const means = { code: "59", directDebit };
    expect(paymentMeansPdfText({ ...base, dueDate: null, paymentMeans: means }, "de")).toContain("zum Fälligkeitsdatum per SEPA-Lastschrift");
    const en = paymentMeansPdfText({ ...base, dueDate: null, paymentMeans: means }, "en");
    expect(en).toContain("on the due date by SEPA direct debit from your account DE02 **** 2051");
    expect(en).toContain("Mandate reference: MANDAT-2183-001, creditor ID: DE98ZZZ09999999999.");
    expect(paymentMeansPdfText({ ...base, paymentMeans: means }, "en")).toContain("on 26/03/2183");
  });
  it("Karte de/en, nur 4 Ziffern", () => {
    const means = { code: "48", card: { panTruncated: "1234", network: "VISA", holderName: null } };
    expect(paymentMeansPdfText({ ...base, paymentMeans: means }, "de")).toBe("Zahlung per Karte (VISA) **** 1234.");
    expect(paymentMeansPdfText({ ...base, paymentMeans: means }, "en")).toBe("Payment by card (VISA) **** 1234.");
  });
  it("Code 58 / Fallback / ohne -> null", () => {
    expect(paymentMeansPdfText({ ...base, paymentMeans: { code: "58", iban: "DE12500105170648489890" } }, "de")).toBeNull();
    expect(paymentMeansPdfText({ ...base, paymentMeans: { code: "1" } }, "de")).toBeNull();
    expect(paymentMeansPdfText({ ...base, paymentMeans: null }, "de")).toBeNull();
  });
});

describe("invoice-pdf — Phase 18e: Lastschrift/Karte", () => {
  it("Lastschrift: Vorabankuendigung, keine volle IBAN, kein GiroCode", async () => {
    const pdf = await renderInvoicePdf(invoice({ code: "59", directDebit }), testPdfTheme());
    const text = flat((await parsePdf(pdf)).text);
    expect(text).toContain("Mandatsreferenz: MANDAT-2183-001");
    expect(text).toContain("DE98ZZZ09999999999");
    expect(text).toContain("DE02 **** 2051");
    expect(text).not.toContain(DEBTOR_IBAN);
    expect(text).not.toContain("GiroCode");
  });
  it("Karte: Hinweis, kein GiroCode", async () => {
    const pdf = await renderInvoicePdf(invoice({ code: "48", card: { panTruncated: "1234", network: "VISA", holderName: null } }), testPdfTheme());
    const text = flat((await parsePdf(pdf)).text);
    expect(text).toContain("Zahlung per Karte (VISA) **** 1234");
    expect(text).not.toContain("GiroCode");
  });
  it("Fallback-Code 1 mit Org-IBAN: GiroCode wie bisher", async () => {
    const pdf = await renderInvoicePdf(invoice({ code: "1" }), testPdfTheme());
    const text = flat((await parsePdf(pdf)).text);
    expect(text).toContain("GiroCode");
    expect(text).not.toContain("Mandatsreferenz");
  });
});
