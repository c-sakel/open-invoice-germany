import { describe, it, expect } from "vitest";
import {
  SMALL_AMOUNT_LIMIT_CENTS,
  grossEurCentsOf,
  isSmallAmountInvoice,
  issueDeadline,
  isIssueDeadlineMissed,
  resolveConsumerDefaultNotice,
} from "@/domain/invoice/checks";
import { berlinDateKey } from "@/lib/berlin-time";

const de = { countryCode: "DE", vatId: null };
function small(over: Partial<Parameters<typeof isSmallAmountInvoice>[0]> = {}) {
  return isSmallAmountInvoice({ type: "INVOICE", taxScheme: "REGULAR", grossEurCents: 25_000, buyer: de, ...over });
}

describe("Kleinbetragsrechnung", () => {
  it("Grenze 250,00 EUR", () => {
    expect(SMALL_AMOUNT_LIMIT_CENTS).toBe(25_000);
    expect(small({ grossEurCents: 25_000 })).toBe(true);
    expect(small({ grossEurCents: 25_001 })).toBe(false);
    expect(small({ grossEurCents: 1 })).toBe(true);
  });
  it("0, negativ und unbekannt sind keine Kleinbetragsrechnung", () => {
    expect(small({ grossEurCents: 0 })).toBe(false);
    expect(small({ grossEurCents: -500 })).toBe(false);
    expect(small({ grossEurCents: null })).toBe(false);
  });
  it("nur Rechnungen, keine Gutschriften", () => {
    expect(small({ type: "CREDIT_NOTE" })).toBe(false);
    expect(small({ type: "CORRECTION" })).toBe(false);
  });
  it("ig. Lieferung, Reverse Charge und ig. Leistung sind ausgeschlossen", () => {
    for (const taxScheme of ["IG_LIEFERUNG", "REVERSE_CHARGE", "IG_LEISTUNG"]) expect(small({ taxScheme })).toBe(false);
  });
  it("EU-Privatkunde im Ausland ausgeschlossen, Inland und Geschaeftskunde nicht", () => {
    expect(small({ buyer: { countryCode: "FR", vatId: null } })).toBe(false);
    expect(small({ buyer: { countryCode: "FR", vatId: "FR12345678901" } })).toBe(true);
    expect(small({ buyer: { countryCode: "DE", vatId: null } })).toBe(true);
    expect(small({ buyer: { countryCode: "US", vatId: null } })).toBe(true);
    expect(small({ buyer: null })).toBe(true);
  });
  it("Kleinunternehmer mit 100,00 EUR", () => {
    expect(small({ taxScheme: "KLEINUNTERNEHMER", grossEurCents: 10_000 })).toBe(true);
  });
  it("Brutto in EUR: Fremdwaehrung nur mit eingefrorenen EUR-Werten", () => {
    expect(grossEurCentsOf({ currency: "EUR", grossTotalCents: 11_900, netTotalEurCents: null, taxTotalEurCents: null })).toBe(11_900);
    expect(grossEurCentsOf({ currency: "USD", grossTotalCents: 11_900, netTotalEurCents: null, taxTotalEurCents: null })).toBeNull();
    expect(grossEurCentsOf({ currency: "USD", grossTotalCents: 11_900, netTotalEurCents: 9_000, taxTotalEurCents: null })).toBeNull();
    expect(grossEurCentsOf({ currency: "USD", grossTotalCents: 11_900, netTotalEurCents: 9_000, taxTotalEurCents: 1_710 })).toBe(10_710);
    expect(small({ grossEurCents: grossEurCentsOf({ currency: "USD", grossTotalCents: 100, netTotalEurCents: null, taxTotalEurCents: null }) })).toBe(false);
  });
});

describe("Ausstellfrist § 14a UStG", () => {
  const key = (d: Date | null) => (d ? berlinDateKey(d) : null);
  it("15. des Folgemonats", () => {
    expect(key(issueDeadline({ taxScheme: "IG_LIEFERUNG", deliveryDate: new Date("2230-03-03T10:00:00Z"), deliveryEnd: null }))).toBe("2230-04-15");
  });
  it("Leistungszeitraum: Ende zaehlt, Dezember -> Januar Folgejahr", () => {
    expect(
      key(issueDeadline({ taxScheme: "IG_LEISTUNG", deliveryDate: new Date("2230-12-01T10:00:00Z"), deliveryEnd: new Date("2230-12-31T10:00:00Z") })),
    ).toBe("2231-01-15");
  });
  it("Berliner Kalendertag: 31.01. 23:30 UTC ist 01.02. in Berlin", () => {
    expect(key(issueDeadline({ taxScheme: "IG_LIEFERUNG", deliveryDate: new Date("2230-01-31T23:30:00Z"), deliveryEnd: null }))).toBe("2230-03-15");
  });
  it("sonstige Schemata und fehlendes Leistungsdatum ohne Frist", () => {
    expect(issueDeadline({ taxScheme: "REGULAR", deliveryDate: new Date("2230-03-03T10:00:00Z"), deliveryEnd: null })).toBeNull();
    expect(issueDeadline({ taxScheme: "IG_LIEFERUNG", deliveryDate: null, deliveryEnd: null })).toBeNull();
  });
  it("verpasst erst nach dem Fristtag (Berliner Tag)", () => {
    const deadline = issueDeadline({ taxScheme: "IG_LIEFERUNG", deliveryDate: new Date("2230-03-03T10:00:00Z"), deliveryEnd: null });
    expect(isIssueDeadlineMissed(deadline, new Date("2230-04-15T10:00:00Z"))).toBe(false);
    expect(isIssueDeadlineMissed(deadline, new Date("2230-04-15T21:30:00Z"))).toBe(false); // 23:30 Berliner Zeit: noch der 15.
    expect(isIssueDeadlineMissed(deadline, new Date("2230-04-15T22:30:00Z"))).toBe(true); // 00:30 Berliner Zeit: schon der 16.
    expect(isIssueDeadlineMissed(deadline, new Date("2230-04-16T10:00:00Z"))).toBe(true);
    expect(isIssueDeadlineMissed(null, new Date("2230-04-16T10:00:00Z"))).toBe(false);
  });
});

describe("Verzugshinweis § 286 Abs. 3 BGB", () => {
  const rows: Array<[string, string, boolean | null, string, boolean, boolean]> = [
    // status, type, stored, customerType, setting, erwartet
    ["DRAFT", "INVOICE", null, "CONSUMER", true, true],
    ["DRAFT", "INVOICE", null, "CONSUMER", false, false],
    ["DRAFT", "INVOICE", null, "BUSINESS", true, false],
    ["DRAFT", "INVOICE", false, "CONSUMER", true, false],
    ["DRAFT", "INVOICE", true, "BUSINESS", false, true],
    ["DRAFT", "FINAL", null, "CONSUMER", true, true],
    ["DRAFT", "PARTIAL", null, "CONSUMER", true, true],
    ["DRAFT", "DOWNPAYMENT", null, "CONSUMER", true, true],
    ["DRAFT", "CREDIT_NOTE", null, "CONSUMER", true, false],
    ["DRAFT", "CREDIT_NOTE", true, "CONSUMER", true, false],
    ["DRAFT", "CORRECTION", null, "CONSUMER", true, false],
    ["FINALIZED", "INVOICE", true, "CONSUMER", false, true],
    ["FINALIZED", "INVOICE", false, "CONSUMER", true, false],
    ["FINALIZED", "INVOICE", null, "CONSUMER", true, false],
    ["PAID", "INVOICE", null, "BUSINESS", true, false],
    ["SENT", "INVOICE", true, "BUSINESS", false, true],
    ["CANCELLED", "CREDIT_NOTE", true, "CONSUMER", true, false],
  ];
  it.each(rows)("%s %s stored=%s kunde=%s einstellung=%s -> %s", (status, type, stored, customerType, settingEnabled, expected) => {
    expect(resolveConsumerDefaultNotice({ status, type, stored, customerType, settingEnabled })).toBe(expected);
  });
});
