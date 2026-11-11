/**
 * Phase 16b, Task 6: BT-6 (TaxCurrencyCode) und BT-111 (USt in EUR) in UBL und CII,
 * Belegsprache im XML (BT-120, BT-20). Rein DB-frei ueber buildEInvoiceData.
 * Daten: 112,14 USD netto, USt 19 % = 21,31 USD, Kurs 1,1214 -> 19,00 EUR.
 */
import { describe, it, expect } from "vitest";
import { buildEInvoiceData, type MapInput } from "@/lib/einvoice/mapper";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { deductionsNoteText } from "@/lib/einvoice/deduction-note";
import { de } from "@/lib/i18n/doc/de";
import { en } from "@/lib/i18n/doc/en";

const ORG: MapInput["org"] = {
  legalName: "Test GmbH", addressLine1: "Hauptstr. 1", addressLine2: null, postalCode: "21339", city: "Lüneburg", country: "DE",
  vatId: "DE123456789", taxNumber: null, email: "info@test.de", phone: null, electronicAddress: null,
  iban: "DE02120300000000202051", bic: "BYLADEM1001", bankName: "Test Bank", accountHolder: null,
};
const CUSTOMER: MapInput["customer"] = {
  name: "Kunde AG", contactName: null, addressLine1: "Marktplatz 2", addressLine2: null, postalCode: "20095", city: "Hamburg",
  countryCode: "DE", vatId: "DE987654321", email: "k@kunde.de", leitwegId: null,
};
const CUSTOMER_NL: MapInput["customer"] = { ...CUSTOMER, name: "Beispiel BV", countryCode: "NL", postalCode: "1015", city: "Amsterdam", vatId: "NL123456789B01" };

function input(over: Partial<MapInput> = {}): MapInput {
  return {
    number: "RE-2044-0001", type: "INVOICE", issueDate: new Date("2044-03-10"), dueDate: new Date("2044-04-09"), deliveryDate: new Date("2044-03-05"),
    currency: "USD", language: "de",
    fxRateMicros: 1121400, fxRateDate: new Date("2044-03-01"), fxRateSource: "BMF_MONTHLY", taxTotalEurCents: 1900, netTotalEurCents: 10000,
    buyerReference: null, paymentTerms: "Zahlbar in 30 Tagen.", notes: null,
    netTotalCents: 11214, taxTotalCents: 2131, grossTotalCents: 13345, paidAmountCents: 0,
    taxBreakdownJson: JSON.stringify([{ taxCategory: "S", taxRate: 19, netCents: 11214, taxCents: 2131, baseNetCents: 11214, allowanceCents: 0, chargeCents: 0 }]),
    org: ORG, customer: CUSTOMER,
    lines: [{ id: "1", description: "Consulting", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 11214, lineNetCents: 11214, taxRate: 19, taxCategory: "S" }],
    ...over,
  };
}

const RATE_NOTE_DE = de.fx.rateLine("1,1214", "USD", de.fx.monthlyRateLabel(2044, 3), "");

describe("BT-6 / BT-111 in UBL", () => {
  const xml = buildXRechnungUBL(buildEInvoiceData(input()));

  it("TaxCurrencyCode EUR steht direkt nach DocumentCurrencyCode", () => {
    expect(xml).toMatch(/<cbc:DocumentCurrencyCode>USD<\/cbc:DocumentCurrencyCode>\s*<cbc:TaxCurrencyCode>EUR<\/cbc:TaxCurrencyCode>/);
  });
  it("zweites TaxTotal nur mit TaxAmount in EUR, ohne TaxSubtotal", () => {
    const totals = xml.match(/<cac:TaxTotal>[\s\S]*?<\/cac:TaxTotal>/g) ?? [];
    expect(totals).toHaveLength(2);
    expect(totals[0]).toContain('currencyID="USD">21.31');
    expect(totals[0]).toContain("cac:TaxSubtotal");
    expect(totals[1].replace(/\s+/g, "")).toBe('<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount></cac:TaxTotal>'.replace(/\s+/g, ""));
  });
  it("BT-22 traegt die Kursnotiz", () => {
    expect(xml).toContain(`<cbc:Note>${RATE_NOTE_DE}</cbc:Note>`);
  });
  it("Kernvalidierung (inkl. BR-53) ist gruen", () => {
    const data = buildEInvoiceData(input());
    expect(validateXRechnung(data, xml)).toEqual({ valid: true, errors: [] });
  });
  it("BR-53: TaxCurrencyCode ohne EUR-TaxTotal ist ein Fehler", () => {
    const data = buildEInvoiceData(input());
    const broken = xml.replace(/<cac:TaxTotal>\s*<cbc:TaxAmount currencyID="EUR">[^<]*<\/cbc:TaxAmount>\s*<\/cac:TaxTotal>/, "");
    const report = validateXRechnung(data, broken);
    expect(report.valid).toBe(false);
    expect(report.errors.join("\n")).toContain("BR-53");
  });
  it("Gutschrift: zweites TaxTotal positiv", () => {
    const credit = buildEInvoiceData(
      input({
        type: "CREDIT_NOTE", paymentTerms: null, netTotalCents: -11214, taxTotalCents: -2131, grossTotalCents: -13345,
        taxTotalEurCents: -1900, netTotalEurCents: -10000,
        taxBreakdownJson: JSON.stringify([{ taxCategory: "S", taxRate: 19, netCents: -11214, taxCents: -2131, baseNetCents: -11214, allowanceCents: 0, chargeCents: 0 }]),
        lines: [{ id: "1", description: "Consulting", quantityMilli: 1000, unit: "C62", unitNetPriceCents: -11214, lineNetCents: -11214, taxRate: 19, taxCategory: "S" }],
      }),
    );
    const out = buildXRechnungUBL(credit);
    expect(out).toContain('<cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>');
    expect(out).not.toContain("-19.00");
  });
});

describe("BT-6 / BT-111 in CII", () => {
  const xml = buildFacturXCII(buildEInvoiceData(input()));

  it("TaxCurrencyCode unmittelbar vor InvoiceCurrencyCode", () => {
    expect(xml).toMatch(/<ram:TaxCurrencyCode>EUR<\/ram:TaxCurrencyCode>\s*<ram:InvoiceCurrencyCode>USD<\/ram:InvoiceCurrencyCode>/);
  });
  it("zwei TaxTotalAmount (USD, EUR) in der XSD-Reihenfolge nach TaxBasisTotalAmount", () => {
    expect(xml).toMatch(
      /<ram:TaxBasisTotalAmount>[^<]*<\/ram:TaxBasisTotalAmount>\s*<ram:TaxTotalAmount currencyID="USD">21\.31<\/ram:TaxTotalAmount>\s*<ram:TaxTotalAmount currencyID="EUR">19\.00<\/ram:TaxTotalAmount>\s*<ram:GrandTotalAmount>/,
    );
  });
  it("BT-22 traegt die Kursnotiz", () => {
    expect(xml).toContain(`<ram:Content>${RATE_NOTE_DE}</ram:Content>`);
  });
  it("Gutschrift: EUR-Steuer positiv", () => {
    const credit = buildEInvoiceData(
      input({ type: "CREDIT_NOTE", paymentTerms: null, netTotalCents: -11214, taxTotalCents: -2131, grossTotalCents: -13345, taxTotalEurCents: -1900, netTotalEurCents: -10000 }),
    );
    expect(buildFacturXCII(credit)).toContain('<ram:TaxTotalAmount currencyID="EUR">19.00</ram:TaxTotalAmount>');
  });
});

describe("EUR-Belege und unvollstaendiger Snapshot", () => {
  const eur = input({ currency: "EUR", fxRateMicros: null, fxRateDate: null, fxRateSource: null, taxTotalEurCents: null, netTotalEurCents: null });
  it("EUR: weder TaxCurrencyCode noch zweites TaxTotal noch Kursnotiz", () => {
    const ubl = buildXRechnungUBL(buildEInvoiceData(eur));
    const cii = buildFacturXCII(buildEInvoiceData(eur));
    expect(ubl).not.toContain("TaxCurrencyCode");
    expect(ubl.match(/<cac:TaxTotal>/g)).toHaveLength(1);
    expect(ubl).not.toContain("Umrechnungskurs");
    expect(cii).not.toContain("TaxCurrencyCode");
    expect(cii.match(/<ram:TaxTotalAmount/g)).toHaveLength(1);
  });
  it("EUR-Beleg ignoert auch einen (unsinnig) gesetzten Kurs", () => {
    expect(buildEInvoiceData(input({ currency: "EUR" })).fx).toBeNull();
  });
  it("Fremdwaehrung ohne Snapshot: kein EUR-Block", () => {
    expect(buildEInvoiceData(input({ fxRateMicros: null })).fx).toBeNull();
  });
});

describe("Belegsprache im XML", () => {
  const reverseCharge = (language: string) =>
    input({
      currency: "EUR", language, customer: CUSTOMER_NL, fxRateMicros: null, fxRateDate: null, fxRateSource: null, taxTotalEurCents: null, netTotalEurCents: null,
      netTotalCents: 10000, taxTotalCents: 0, grossTotalCents: 10000,
      taxBreakdownJson: JSON.stringify([{ taxCategory: "AE", taxRate: 0, netCents: 10000, taxCents: 0, baseNetCents: 10000, allowanceCents: 0, chargeCents: 0 }]),
      lines: [{ id: "1", description: "Services", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, lineNetCents: 10000, taxRate: 0, taxCategory: "AE" }],
      skonto1Permille: 20, skonto1Days: 10, paymentTerms: null,
    });

  it("en: BT-120 englisch, BT-121 unveraendert, BT-20 englisch (UBL und CII)", () => {
    const data = buildEInvoiceData(reverseCharge("en"));
    expect(data.language).toBe("en");
    const ubl = buildXRechnungUBL(data);
    expect(ubl).toContain("<cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>");
    expect(ubl).toContain("<cbc:TaxExemptionReasonCode>VATEX-EU-AE</cbc:TaxExemptionReasonCode>");
    expect(ubl).toContain("#SKONTO#TAGE=10#PROZENT=2.00#"); // Maschinenformat bleibt
    expect(ubl).toContain("cash discount if paid by");
    expect(ubl).toContain("payable net by");
    expect(ubl).not.toContain("Skonto bei");
    const cii = buildFacturXCII(data);
    expect(cii).toContain("<ram:ExemptionReason>Reverse charge</ram:ExemptionReason>");
    expect(cii).toContain("<ram:ExemptionReasonCode>VATEX-EU-AE</ram:ExemptionReasonCode>");
  });
  it("de bleibt Default: unbekannte Sprache faellt auf Deutsch", () => {
    for (const lang of ["de", "fr"]) {
      const ubl = buildXRechnungUBL(buildEInvoiceData(reverseCharge(lang)));
      expect(ubl).toContain("<cbc:TaxExemptionReason>Steuerschuldnerschaft des Leistungsempfängers</cbc:TaxExemptionReason>");
    }
  });
  it("en: Kursnotiz und Gutschrift-Ersatztext englisch", () => {
    const data = buildEInvoiceData(input({ language: "en", type: "CREDIT_NOTE", paymentTerms: null, netTotalCents: -11214, taxTotalCents: -2131, grossTotalCents: -13345, taxTotalEurCents: -1900, netTotalEurCents: -10000 }));
    const ubl = buildXRechnungUBL(data);
    expect(ubl).toContain(en.fx.rateLine("1.1214", "USD", en.fx.monthlyRateLabel(2044, 3), ""));
    expect(ubl).toContain("Credit note – offset or refund");
  });
});

describe("Belegsprache: weitere XML-Texte (Fix-Runde 1)", () => {
  it("Skonto-Betrag in der Belegwaehrung (USD)", () => {
    const data = buildEInvoiceData(input({ paymentTerms: null, skonto1Permille: 20, skonto1Days: 10 }));
    expect(data.paymentTermsHuman).toMatch(/2,67\s\$/);
    expect(data.paymentTermsHuman).not.toContain("€");
  });
  it("en: Aufbewahrungshinweis, Rabatt- und Aufschlaggrund englisch; de unveraendert", () => {
    const withAdjust = (language: string) =>
      buildEInvoiceData(
        input({
          currency: "EUR", language, fxRateMicros: null, fxRateDate: null, fxRateSource: null, taxTotalEurCents: null, netTotalEurCents: null,
          consumerRetentionHint: true,
          taxBreakdownJson: JSON.stringify([{ taxCategory: "S", taxRate: 19, netCents: 11214, taxCents: 2131, baseNetCents: 12000, allowanceCents: 1000, chargeCents: 214 }]),
        }),
      );
    const enXml = buildXRechnungUBL(withAdjust("en"));
    expect(enXml).toContain("You are required to retain this invoice for two years");
    expect(enXml).toContain("<cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>");
    expect(enXml).toContain("<cbc:AllowanceChargeReason>Surcharge</cbc:AllowanceChargeReason>");
    expect(buildFacturXCII(withAdjust("en"))).toContain("<ram:Reason>Discount</ram:Reason>");
    const deXml = buildXRechnungUBL(withAdjust("de"));
    expect(deXml).toContain("Sie sind verpflichtet, diese Rechnung zwei Jahre aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).");
    expect(deXml).toContain("<cbc:AllowanceChargeReason>Rabatt</cbc:AllowanceChargeReason>");
    expect(deXml).toContain("<cbc:AllowanceChargeReason>Aufschlag</cbc:AllowanceChargeReason>");
  });
  it("Abzugsaufstellung je Sprache", () => {
    const ded = [{ number: "AR-1", issueDate: new Date(2044, 1, 1), netCents: 300000, taxCents: 57000, grossCents: 357000 }];
    expect(deductionsNoteText(ded)).toBe("Abzüge: AR-1 vom 01.02.2044: 3.000,00 netto + 570,00 USt = 3.570,00");
    expect(deductionsNoteText(ded, "en")).toBe("Deductions: AR-1 dated 01/02/2044: 3,000.00 net + 570.00 VAT = 3,570.00");
  });
});
