/**
 * Phase 18a, T1: UBL- und CII-Daten sowie die Abzugsnotiz folgen dem Berliner Kalendertag,
 * unabhaengig von TZ. Eine Nacht-Rechnung (23:30 UTC = Folgetag Berlin) liefert dieselben
 * Werte wie das Formulardatum als UTC-Mitternacht.
 */
import { describe, it, expect } from "vitest";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { validateXRechnung } from "@/lib/einvoice/en16931-core";
import { deductionsNoteText } from "@/lib/einvoice/deduction-note";
import type { EInvoiceData } from "@/lib/einvoice/types";

function fixture(issue: string, due: string, delivery: string, deduction: string): EInvoiceData {
  return {
    number: "B18A1-0001",
    type: "FINAL",
    issueDate: new Date(issue),
    dueDate: new Date(due),
    deliveryDate: new Date(delivery),
    currency: "EUR",
    buyerReference: "04011000-12345-86",
    paymentTerms: "Zahlbar innerhalb von 14 Tagen ohne Abzug.",
    notes: null,
    seller: {
      name: "Test GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", countryCode: "DE",
      vatId: "DE123456789", email: "info@test.de", phone: "+49 4131 100", contactName: "Max Mustermann",
    },
    buyer: { name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", vatId: "DE987654321", email: "einkauf@kunde.de" },
    lines: [{ id: "1", description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, lineNetCents: 20000, taxRate: 19, taxCategory: "S" }],
    taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: 20000, taxCents: 3800 }],
    netTotalCents: 20000,
    taxTotalCents: 3800,
    grossTotalCents: 23800,
    payableCents: 23800,
    iban: "DE02120300000000202051",
    bic: "BYLADEM1001",
    bankName: "Test Bank",
    deductions: [{ number: "B18A1-0000", issueDate: new Date(deduction), netCents: 10000, taxCents: 1900, grossCents: 11900 }],
  };
}

const night = fixture("2160-01-14T23:30:00Z", "2160-01-28T23:30:00Z", "2160-01-14T23:30:00Z", "2160-01-09T23:30:00Z");
const midnight = fixture("2160-01-15T00:00:00Z", "2160-01-29T00:00:00Z", "2160-01-15T00:00:00Z", "2160-01-10T00:00:00Z");

describe("E-Rechnung: Berliner Kalendertag", () => {
  for (const [label, data] of [["Nachtwerte", night], ["UTC-Mitternacht", midnight]] as const) {
    it(`UBL ${label}: BT-2, BT-9, BT-72`, () => {
      const xml = buildXRechnungUBL(data);
      expect(xml).toContain("<cbc:IssueDate>2160-01-15</cbc:IssueDate>");
      expect(xml).toContain("<cbc:DueDate>2160-01-29</cbc:DueDate>");
      expect(xml).toContain("<cbc:ActualDeliveryDate>2160-01-15</cbc:ActualDeliveryDate>");
      expect(xml).toContain("10.01.2160");
      expect(validateXRechnung(data, xml).errors).toEqual([]);
    });

    it(`CII ${label}: BT-2 und Lieferdatum`, () => {
      const xml = buildFacturXCII(data);
      expect(xml).toContain('<udt:DateTimeString format="102">21600115</udt:DateTimeString>');
      expect(xml).not.toContain("21600114");
    });
  }

  it("Abzugsnotiz deutsch und englisch", () => {
    expect(deductionsNoteText(night.deductions!, "de")).toContain("10.01.2160");
    expect(deductionsNoteText(night.deductions!, "en")).toContain("10/01/2160");
  });
});
