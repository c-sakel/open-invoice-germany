/**
 * Phase 18e — Karte (BG-18) und SEPA-Lastschrift (BG-19) in XRechnung (UBL) und ZUGFeRD (CII).
 * Fiktive Testwerte; Testjahr 2180.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildEInvoiceData, type MapInput } from "@/lib/einvoice/mapper";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { resolveSpecialMeans } from "@/lib/einvoice/payment-means";
import type { DirectDebitSnapshot } from "@/schemas";

const ORG: MapInput["org"] = {
  legalName: "Test GmbH", addressLine1: "Hauptstr. 1", addressLine2: null, postalCode: "21339", city: "Lüneburg",
  country: "DE", vatId: "DE123456789", taxNumber: null, email: "info@example.org", phone: null,
  electronicAddress: null, iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Test Bank",
  accountHolder: null,
};
const CUSTOMER: MapInput["customer"] = {
  name: "Kunde AG", contactName: null, addressLine1: "Marktplatz 2", addressLine2: null, postalCode: "20095",
  city: "Hamburg", countryCode: "DE", vatId: "DE987654321", email: "einkauf@example.org", leitwegId: null,
};
const SNAPSHOT: DirectDebitSnapshot = {
  creditorId: "DE98ZZZ09999999999",
  mandateReference: "MANDAT-2180-001",
  mandateSignedAt: "2180-01-15",
  debtorIban: "DE02120300000000202051",
  debtorAccountName: "Erika Beispiel",
};
const DEBIT_JSON = JSON.stringify(SNAPSHOT);

function pmJson(untdidCode: string): string {
  return JSON.stringify({
    code: "X", name: "X", invoiceText: null, untdidCode, bankIban: null, bankBic: null, bankName: null,
  });
}

function input(over: Partial<MapInput> = {}): MapInput {
  return {
    number: "RE-2180-0001", type: "INVOICE",
    issueDate: new Date("2180-06-09"), dueDate: new Date("2180-07-09"), deliveryDate: new Date("2180-06-01"),
    currency: "EUR", buyerReference: null, paymentTerms: "Zahlbar in 30 Tagen.", notes: null,
    netTotalCents: 10000, taxTotalCents: 1900, grossTotalCents: 11900, paidAmountCents: 0,
    taxBreakdownJson: JSON.stringify([{ taxRate: 19, taxCategory: "S", netCents: 10000, taxCents: 1900 }]),
    org: ORG, customer: CUSTOMER,
    lines: [{
      id: "1", description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000,
      lineNetCents: 10000, taxRate: 19, taxCategory: "S",
    }],
    ...over,
  };
}

function render(over: Partial<MapInput>) {
  const data = buildEInvoiceData(input(over));
  // Formatierter XML-Text: Whitespace zwischen Tags kollabieren, damit Reihenfolgen als Substring pruefbar sind.
  const flat = (x: string) => x.replace(/>\s+</g, "><");
  return { data, ubl: flat(buildXRechnungUBL(data)), cii: flat(buildFacturXCII(data)) };
}

afterEach(() => vi.restoreAllMocks());

describe("resolveSpecialMeans", () => {
  const DUE = new Date("2180-07-09");
  const card = { cardPanTruncated: "1234", cardNetwork: "VISA", cardHolderName: null };
  it("regulaere Codes", () => {
    expect(resolveSpecialMeans({ code: "58", invoiceType: "INVOICE", card: null, directDebit: null, dueDate: DUE })).toEqual({ kind: "regular" });
  });
  it("Karte vollstaendig / unvollstaendig", () => {
    expect(resolveSpecialMeans({ code: "54", invoiceType: "INVOICE", card, directDebit: null, dueDate: DUE })).toEqual({
      kind: "card", card: { panTruncated: "1234", network: "VISA", holderName: null },
    });
    expect(resolveSpecialMeans({ code: "54", invoiceType: "INVOICE", card: { ...card, cardNetwork: null }, directDebit: null, dueDate: DUE }))
      .toEqual({ kind: "fallback", gap: "karte-unvollstaendig" });
    expect(resolveSpecialMeans({ code: "54", invoiceType: "INVOICE", card: { ...card, cardPanTruncated: null }, directDebit: null, dueDate: DUE }))
      .toEqual({ kind: "fallback", gap: "karte-unvollstaendig" });
  });
  it("Lastschrift mit/ohne Snapshot", () => {
    expect(resolveSpecialMeans({ code: "59", invoiceType: "INVOICE", card: null, directDebit: SNAPSHOT, dueDate: DUE }))
      .toEqual({ kind: "directDebit", directDebit: SNAPSHOT });
    expect(resolveSpecialMeans({ code: "59", invoiceType: "INVOICE", card: null, directDebit: null, dueDate: DUE }))
      .toEqual({ kind: "fallback", gap: "lastschrift-unvollstaendig" });
  });
  it("leere Snapshot-Strings und ungueltige Kartenziffern -> Fallback mit Hinweis", () => {
    for (const k of ["creditorId", "mandateReference", "debtorIban"] as const) {
      expect(resolveSpecialMeans({ code: "59", invoiceType: "INVOICE", card: null, directDebit: { ...SNAPSHOT, [k]: "" }, dueDate: DUE }))
        .toEqual({ kind: "fallback", gap: "lastschrift-unvollstaendig" });
    }
    for (const pan of ["123", "12345", "12a4"]) {
      expect(resolveSpecialMeans({ code: "54", invoiceType: "INVOICE", card: { ...card, cardPanTruncated: pan }, directDebit: null, dueDate: DUE }))
        .toEqual({ kind: "fallback", gap: "karte-unvollstaendig" });
    }
  });
  it("Lastschrift ohne Faelligkeitsdatum -> Fallback mit eigenem Hinweis", () => {
    for (const dueDate of [null, undefined]) {
      expect(resolveSpecialMeans({ code: "59", invoiceType: "INVOICE", card: null, directDebit: SNAPSHOT, dueDate }))
        .toEqual({ kind: "fallback", gap: "lastschrift-faelligkeit" });
    }
  });
  it("Gutschrift: Fallback ohne Hinweis", () => {
    expect(resolveSpecialMeans({ code: "59", invoiceType: "CREDIT_NOTE", card: null, directDebit: SNAPSHOT, dueDate: DUE }))
      .toEqual({ kind: "fallback", gap: null });
    expect(resolveSpecialMeans({ code: "54", invoiceType: "CREDIT_NOTE", card, directDebit: null, dueDate: DUE }))
      .toEqual({ kind: "fallback", gap: null });
  });
});

describe("Lastschrift BG-19", () => {
  const over = { paymentMethodSnapshotJson: pmJson("59"), directDebitSnapshotJson: DEBIT_JSON };
  it("UBL: Code 59, PaymentMandate, BT-90 nur beim Verkaeufer", () => {
    const { ubl, data } = render(over);
    expect(ubl).toContain("<cbc:PaymentMeansCode>59</cbc:PaymentMeansCode>");
    expect(ubl).toContain("<cac:PaymentMandate><cbc:ID>MANDAT-2180-001</cbc:ID><cac:PayerFinancialAccount><cbc:ID>DE02120300000000202051</cbc:ID>");
    expect(ubl).not.toContain("PayeeFinancialAccount");
    const supplier = ubl.slice(ubl.indexOf("<cac:AccountingSupplierParty>"), ubl.indexOf("</cac:AccountingSupplierParty>"));
    const customer = ubl.slice(ubl.indexOf("<cac:AccountingCustomerParty>"), ubl.indexOf("</cac:AccountingCustomerParty>"));
    expect(supplier).toContain('<cbc:ID schemeID="SEPA">DE98ZZZ09999999999</cbc:ID>');
    expect(customer).not.toContain("SEPA");
    expect(supplier.indexOf("EndpointID")).toBeLessThan(supplier.indexOf("PartyIdentification"));
    expect(supplier.indexOf("PartyIdentification")).toBeLessThan(supplier.indexOf("PostalAddress"));
    expect(validateXRechnung(data, ubl).valid).toBe(true);
  });
  it("CII: CreditorReferenceID zuerst, Payer-Konto, Mandat nach Description", () => {
    const { cii } = render(over);
    expect(cii).toMatch(/<ram:ApplicableHeaderTradeSettlement>\s*<ram:CreditorReferenceID>DE98ZZZ09999999999</);
    expect(cii).toContain("<ram:TypeCode>59</ram:TypeCode>");
    expect(cii).toMatch(/<ram:PayerPartyDebtorFinancialAccount>\s*<ram:IBANID>DE02120300000000202051/);
    expect(cii).not.toContain("PayeePartyCreditorFinancialAccount");
    expect(cii.indexOf("<ram:Description>Zahlbar")).toBeLessThan(cii.indexOf("<ram:DirectDebitMandateID>MANDAT-2180-001"));
  });
  it("CII ohne Zahlungsbedingungstext: PaymentTerms nur mit Mandat", () => {
    const { cii } = render({ ...over, paymentTerms: null });
    expect(cii).toMatch(/<ram:SpecifiedTradePaymentTerms>\s*<ram:DirectDebitMandateID>MANDAT-2180-001<\/ram:DirectDebitMandateID>\s*<\/ram:SpecifiedTradePaymentTerms>/);
  });
  it("CII mit fx: CreditorReferenceID vor TaxCurrencyCode", () => {
    const { cii } = render({
      ...over, currency: "USD", fxRateMicros: 1121400, fxRateDate: new Date("2180-03-01"), fxRateSource: "BMF_MONTHLY",
      taxTotalEurCents: 1900, netTotalEurCents: 10000,
    });
    expect(cii.indexOf("CreditorReferenceID")).toBeGreaterThan(-1);
    expect(cii.indexOf("CreditorReferenceID")).toBeLessThan(cii.indexOf("TaxCurrencyCode"));
  });
});

describe("Karte BG-18", () => {
  const over = {
    paymentMethodSnapshotJson: pmJson("54"), cardPanTruncated: "1234", cardNetwork: "VISA", cardHolderName: "Erika Beispiel",
  };
  it("UBL: CardAccount nach PaymentMeansCode, ohne Konto/Mandat", () => {
    const { ubl, data } = render(over);
    expect(ubl).toContain(
      "<cbc:PaymentMeansCode>54</cbc:PaymentMeansCode><cac:CardAccount><cbc:PrimaryAccountNumberID>1234</cbc:PrimaryAccountNumberID><cbc:NetworkID>VISA</cbc:NetworkID><cbc:HolderName>Erika Beispiel</cbc:HolderName></cac:CardAccount>",
    );
    expect(ubl).not.toContain("PayeeFinancialAccount");
    expect(ubl).not.toContain("PaymentMandate");
    expect(ubl).not.toContain('schemeID="SEPA"');
    expect(validateXRechnung(data, ubl).valid).toBe(true);
  });
  it("UBL ohne Inhaber: kein HolderName", () => {
    expect(render({ ...over, cardHolderName: null }).ubl).not.toContain("HolderName");
  });
  it("CII: FinancialCard", () => {
    const { cii } = render(over);
    expect(cii).toMatch(/<ram:ApplicableTradeSettlementFinancialCard>\s*<ram:ID>1234<\/ram:ID>\s*<ram:CardholderName>Erika Beispiel/);
    expect(cii).not.toContain("PayeePartyCreditorFinancialAccount");
  });
});

describe("Rueckfall und Bestandsgleichheit", () => {
  it("59 ohne Snapshot und 54 ohne Kartenfelder = Aufruf ohne neue Schluessel", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const code of ["59", "54"]) {
      const base = { paymentMethodSnapshotJson: pmJson(code) };
      const a = render(base);
      const b = render({ ...base, cardPanTruncated: null, cardNetwork: null, cardHolderName: null, directDebitSnapshotJson: null });
      expect(b.ubl).toBe(a.ubl);
      expect(b.cii).toBe(a.cii);
      expect(a.ubl).toContain("<cbc:PaymentMeansCode>1</cbc:PaymentMeansCode>");
    }
  });
  it("kaputter Snapshot -> Code 1, Warnung ohne IBAN", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ubl } = render({ paymentMethodSnapshotJson: pmJson("59"), directDebitSnapshotJson: "{kaputt" });
    expect(ubl).toContain("<cbc:PaymentMeansCode>1</cbc:PaymentMeansCode>");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("DE02");
  });
  it("Gutschrift mit 59 + Snapshot: Code 1", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ubl } = render({ type: "CREDIT_NOTE", paymentMethodSnapshotJson: pmJson("59"), directDebitSnapshotJson: DEBIT_JSON });
    expect(ubl).toContain("<cbc:PaymentMeansCode>1</cbc:PaymentMeansCode>");
    expect(ubl).not.toContain("PaymentMandate");
  });
  it("58 mit IBAN unveraendert", () => {
    const { ubl } = render({ paymentMethodSnapshotJson: pmJson("58") });
    expect(ubl).toContain("PayeeFinancialAccount");
    expect(ubl).not.toContain('schemeID="SEPA"');
    expect(ubl).not.toContain("CardAccount");
  });
});
