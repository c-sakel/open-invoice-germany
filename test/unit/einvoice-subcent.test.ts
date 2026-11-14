/**
 * Phase 18f, Task 4 — BT-146 mit fuenf Nachkommastellen (Milli-Cent-Preis) und BG-26
 * (Leistungszeitraum je Position) in UBL und CII; Bestandsobjekte ohne neue Felder bleiben identisch.
 */
import { describe, it, expect } from "vitest";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { buildEInvoiceData, type MapInput } from "@/lib/einvoice/mapper";
import type { EInvoiceData, EInvoiceLine } from "@/lib/einvoice/types";

const START = new Date("2186-03-01T00:00:00.000Z");
const END = new Date("2186-03-31T00:00:00.000Z");

function invoice(lines: EInvoiceLine[], type: "INVOICE" | "CREDIT_NOTE" = "INVOICE"): EInvoiceData {
  const net = lines.reduce((s, l) => s + l.lineNetCents, 0);
  const tax = Math.round(net * 0.19);
  return {
    number: "RE-2186-9001",
    type,
    issueDate: new Date("2186-04-02"),
    dueDate: new Date("2186-05-02"),
    deliveryDate: new Date("2186-03-31"),
    currency: "EUR",
    buyerReference: "04011000-12345-86",
    paymentTerms: "Zahlbar innerhalb von 30 Tagen.",
    notes: "Danke.",
    seller: { name: "Test GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", countryCode: "DE", vatId: "DE123456789", email: "info@test.de", phone: "+49 4131 100", contactName: "Max Mustermann" },
    buyer: { name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", vatId: "DE987654321", email: "einkauf@kunde.de" },
    lines,
    taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: net, taxCents: tax }],
    netTotalCents: net,
    taxTotalCents: tax,
    grossTotalCents: net + tax,
    payableCents: net + tax,
    iban: "DE02120300000000202051",
    bic: "BYLADEM1001",
    bankName: "Test Bank",
  };
}

const milliLine: EInvoiceLine = {
  id: "1", description: "API-Aufrufe", quantityMilli: 10_000_000, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: 200,
  lineNetCents: 2000, taxRate: 19, taxCategory: "S", servicePeriodStart: START, servicePeriodEnd: END,
};
const centLine: EInvoiceLine = { id: "2", description: "Grundgebühr", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 2900, lineNetCents: 2900, taxRate: 19, taxCategory: "S" };

describe("E-Rechnung: Milli-Preis (BT-146) und Leistungszeitraum (BG-26)", () => {
  it("UBL: PriceAmount mit fuenf Stellen, Betrag zweistellig, Cent-Zeile wie bisher", () => {
    const xml = buildXRechnungUBL(invoice([milliLine, centLine]));
    expect(xml).toContain('<cbc:PriceAmount currencyID="EUR">0.00200</cbc:PriceAmount>');
    expect(xml).toContain('<cbc:LineExtensionAmount currencyID="EUR">20.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:PriceAmount currencyID="EUR">29.00</cbc:PriceAmount>');
  });

  it("CII: ChargeAmount mit fuenf Stellen", () => {
    const xml = buildFacturXCII(invoice([milliLine, centLine]));
    expect(xml).toContain("<ram:ChargeAmount>0.00200</ram:ChargeAmount>");
    expect(xml).toContain("<ram:ChargeAmount>29.00</ram:ChargeAmount>");
  });

  it("Gutschrift (negativer Milli-Preis) -> positiver Preis in UBL und CII", () => {
    const credit: EInvoiceLine = { ...milliLine, unitNetPriceMilliCents: -200, lineNetCents: -2000 };
    expect(buildXRechnungUBL(invoice([credit], "CREDIT_NOTE"))).toContain(">0.00200</cbc:PriceAmount>");
    expect(buildFacturXCII(invoice([credit], "CREDIT_NOTE"))).toContain("<ram:ChargeAmount>0.00200</ram:ChargeAmount>");
  });

  it("UBL: InvoicePeriod direkt nach LineExtensionAmount, vor AllowanceCharge", () => {
    const withDiscount: EInvoiceLine = { ...milliLine, unitNetPriceMilliCents: 150, lineNetCents: 1350, grossLineCents: 1500, discountCents: 150, discountPermille: 100 };
    const xml = buildXRechnungUBL(invoice([withDiscount]));
    const iLine = xml.indexOf("<cac:InvoiceLine>");
    const ext = xml.indexOf("<cbc:LineExtensionAmount", iLine);
    const period = xml.indexOf("<cac:InvoicePeriod>", ext);
    const allowance = xml.indexOf("<cac:AllowanceCharge>", ext);
    expect(period).toBeGreaterThan(ext);
    expect(allowance).toBeGreaterThan(period);
    expect(xml.slice(period, allowance)).toContain("<cbc:StartDate>2186-03-01</cbc:StartDate>");
    expect(xml.slice(period, allowance)).toContain("<cbc:EndDate>2186-03-31</cbc:EndDate>");
  });

  it("CII: BillingSpecifiedPeriod direkt nach ApplicableTradeTax, vor SpecifiedTradeAllowanceCharge", () => {
    const withDiscount: EInvoiceLine = { ...milliLine, unitNetPriceMilliCents: 150, lineNetCents: 1350, grossLineCents: 1500, discountCents: 150, discountPermille: 100 };
    const xml = buildFacturXCII(invoice([withDiscount]));
    const settle = xml.indexOf("<ram:SpecifiedLineTradeSettlement>");
    const tax = xml.indexOf("</ram:ApplicableTradeTax>", settle);
    const period = xml.indexOf("<ram:BillingSpecifiedPeriod>", tax);
    const allowance = xml.indexOf("<ram:SpecifiedTradeAllowanceCharge>", tax);
    expect(period).toBeGreaterThan(tax);
    expect(allowance).toBeGreaterThan(period);
    expect(xml.slice(period, allowance)).toContain('<udt:DateTimeString format="102">21860301</udt:DateTimeString>');
    expect(xml.slice(period, allowance)).toContain('<udt:DateTimeString format="102">21860331</udt:DateTimeString>');
  });

  it("ohne Zeitraum kein Zeilen-Zeitraum (nur BG-14 am Beleg, falls gesetzt)", () => {
    const ubl = buildXRechnungUBL(invoice([centLine]));
    const cii = buildFacturXCII(invoice([centLine]));
    expect(ubl).not.toContain("<cac:InvoicePeriod>");
    expect(cii).not.toContain("BillingSpecifiedPeriod");
  });

  it("Bestandsobjekt ohne neue Felder: Preis zweistellig, keine Zeitraeume", () => {
    const xml = buildXRechnungUBL(invoice([centLine]));
    expect(xml).toContain('<cbc:PriceAmount currencyID="EUR">29.00</cbc:PriceAmount>');
    expect(xml).not.toContain("0.00");
  });
});

describe("Mapper: Rabatt-BaseAmount und Durchreichen", () => {
  const baseMap = (lines: MapInput["lines"], type = "INVOICE"): MapInput => ({
    number: "RE-2186-9002", type, issueDate: new Date("2186-04-02"), dueDate: new Date("2186-05-02"), deliveryDate: null,
    deliveryStart: null, deliveryEnd: null, currency: "EUR", language: "de", fxRateMicros: null, fxRateDate: null, fxRateSource: null,
    taxTotalEurCents: null, netTotalEurCents: null, buyerReference: null, orderNumber: null, paymentTerms: null, notes: null, subject: null,
    netTotalCents: 1350, taxTotalCents: 257, grossTotalCents: 1607, paidAmountCents: 0,
    taxBreakdownJson: JSON.stringify([{ taxCategory: "S", taxRate: 19, netCents: 1350, taxCents: 257 }]),
    documentChargeReason: null, skonto1Permille: null, skonto1Days: null, skonto2Permille: null, skonto2Days: null,
    paymentMethodSnapshotJson: null, cardPanTruncated: null, cardNetwork: null, cardHolderName: null, directDebitSnapshotJson: null,
    prepaidCents: 0, deductions: undefined, sourceNumber: null, sourceLabel: null,
    org: { legalName: "Test GmbH", addressLine1: "Hauptstr. 1", addressLine2: null, postalCode: "21339", city: "Lüneburg", countryCode: "DE", vatId: "DE123456789", taxNumber: null, email: "i@t.de", phone: null, contactName: null, iban: null, bic: null, bankName: null } as unknown as MapInput["org"],
    customer: { name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", vatId: null, email: null } as unknown as MapInput["customer"],
    lines,
  });

  it("Milli-Pfad: grossLineCents 1500 bei 10 % Rabatt, Milli und Zeitraum durchgereicht", () => {
    const data = buildEInvoiceData(baseMap([{ id: "1", description: "API", quantityMilli: 10_000_000, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: 150, servicePeriodStart: START, servicePeriodEnd: END, lineNetCents: 1350, taxRate: 19, taxCategory: "S", discountPermille: 100, discountCents: 0 }]));
    const l = data.lines[0]!;
    expect(l.grossLineCents).toBe(1500);
    expect(l.discountCents).toBe(150);
    expect(l.unitNetPriceMilliCents).toBe(150);
    expect(l.servicePeriodStart?.toISOString()).toBe(START.toISOString());
  });

  it("Cent-Zeile: keine neuen Schluessel im Zeilenobjekt", () => {
    const data = buildEInvoiceData(baseMap([{ id: "1", description: "X", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1350, lineNetCents: 1350, taxRate: 19, taxCategory: "S" }]));
    expect(Object.keys(data.lines[0]!)).not.toContain("unitNetPriceMilliCents");
    expect(Object.keys(data.lines[0]!)).not.toContain("servicePeriodStart");
  });

  it("Gutschrift-Zeile mit negativem Milli-Preis rechnet ueber den Betrag (Vorzeichen bleibt)", () => {
    const data = buildEInvoiceData(baseMap([{ id: "1", description: "API", quantityMilli: 10_000_000, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: -150, lineNetCents: -1500, taxRate: 19, taxCategory: "S" }], "CREDIT_NOTE"));
    expect(data.lines[0]!.grossLineCents).toBe(-1500);
    expect(data.lines[0]!.discountCents).toBe(0);
  });
});
