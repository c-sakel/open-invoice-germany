import { describe, expect, it } from "vitest";
import { findInvoiceNumbers, normalizeRef, suggestMatches, type MatchContext, type MatchTransaction, type OpenInvoiceForMatch } from "@/domain/bank/match";
import { skontoTerms } from "@/lib/pricing/skonto";

const HASH = "hash-a";
const issue = new Date("2200-05-01T00:00:00.000Z");

function inv(number: string, openCents: number, over: Partial<OpenInvoiceForMatch> = {}): OpenInvoiceForMatch {
  return {
    id: `id-${number}`,
    number,
    customerId: "c1",
    customerName: "Muster Kundschaft GmbH",
    currency: "EUR",
    openCents,
    issueDate: issue,
    dueDate: new Date("2200-05-15T00:00:00.000Z"),
    skontoTerms: [],
    mandateIbanHash: null,
    ...over,
  };
}

function tx(over: Partial<MatchTransaction> = {}): MatchTransaction {
  return {
    bookingDate: new Date("2200-05-05T00:00:00.000Z"),
    amountCents: 11900,
    allocatedCents: 0,
    currency: "EUR",
    direction: "CRDT",
    counterpartyName: null,
    counterpartyIbanHash: null,
    remittance: "",
    endToEndId: null,
    ...over,
  };
}

const ctx = (invoices: OpenInvoiceForMatch[], hints: Array<[string, string]> = []): MatchContext => ({ invoices, hints: new Map(hints) });

describe("normalizeRef / findInvoiceNumbers", () => {
  it("normalisiert auf Grossbuchstaben und Ziffern", () => {
    expect(normalizeRef("re-50 123/a")).toBe("RE50123A");
  });
  it("findet die volle Nummer, nicht aber laengere oder kuerzere", () => {
    expect(findInvoiceNumbers("Zahlung RE-50123 danke", ["RE-50123"])).toEqual(["RE-50123"]);
    expect(findInvoiceNumbers("Zahlung RE-501234", ["RE-50123"])).toEqual([]);
    expect(findInvoiceNumbers("Zahlung RE-5012", ["RE-50123"])).toEqual([]);
    expect(findInvoiceNumbers("RE-501234 und RE-50123", ["RE-50123"])).toEqual(["RE-50123"]);
  });
  it("toleriert Schreibweisen", () => {
    for (const t of ["RE 50123", "re50123", "Rechnung Nr.RE/50123."]) {
      expect(findInvoiceNumbers(t, ["RE-50123"])).toEqual(["RE-50123"]);
    }
  });
});

describe("suggestMatches", () => {
  it("volle Nummer + exakter Betrag ist SICHER", () => {
    const [s, ...rest] = suggestMatches(tx({ remittance: "Rechnung RE-50123" }), ctx([inv("RE-50123", 11900), inv("RE-50124", 500)]));
    expect(rest).toEqual([]);
    expect(s!.confidence).toBe("SICHER");
    expect(s!.allocations).toEqual([{ invoiceId: "id-RE-50123", number: "RE-50123", amountCents: 11900, applySkonto: false }]);
    expect(s!.reasons).toEqual(expect.arrayContaining(["NUMBER", "AMOUNT"]));
    expect(s!.restCents).toBe(0);
  });

  it("findet die Nummer in EndToEndId und strukturierter Referenz (Text)", () => {
    expect(suggestMatches(tx({ endToEndId: "RE50123" }), ctx([inv("RE-50123", 11900)]))[0]!.confidence).toBe("SICHER");
    expect(suggestMatches(tx({ remittance: "RF18 re 50123" }), ctx([inv("RE-50123", 11900)]))[0]!.reasons).toContain("NUMBER");
  });

  it("nur Ziffernteil ist NUMBER_DIGITS und nie SICHER", () => {
    const [s] = suggestMatches(tx({ remittance: "Rechnung 50123" }), ctx([inv("RE-50123", 11900)]));
    expect(s!.reasons).toContain("NUMBER_DIGITS");
    expect(s!.reasons).not.toContain("NUMBER");
    expect(s!.confidence).toBe("MOEGLICH");
  });

  it("kuerzere Ziffernfolge (unter 4) zaehlt nicht", () => {
    expect(suggestMatches(tx({ remittance: "Rechnung 123" }), ctx([inv("RE-123", 11900)]))).toEqual([]);
  });

  it("abweichender Betrag ist MOEGLICH (Teilzahlung)", () => {
    const [s] = suggestMatches(tx({ amountCents: 5000, remittance: "RE-50123" }), ctx([inv("RE-50123", 11900)]));
    expect(s!.confidence).toBe("MOEGLICH");
    expect(s!.allocations[0]!.amountCents).toBe(5000);
    expect(s!.restCents).toBe(0);
  });

  it("Skontobetrag am letzten Fristtag ist SICHER mit applySkonto, am Folgetag nicht", () => {
    const terms = skontoTerms({ issueDate: issue, grossTotalCents: 11900, skonto1Permille: 20, skonto1Days: 10, skonto2Permille: null, skonto2Days: null });
    const payable = terms[0]!.payableCents;
    const invoice = inv("RE-50123", 11900, { skontoTerms: terms });
    const lastDay = suggestMatches(tx({ amountCents: payable, remittance: "RE-50123", bookingDate: new Date("2200-05-11T00:00:00.000Z") }), ctx([invoice]));
    expect(lastDay[0]!.confidence).toBe("SICHER");
    expect(lastDay[0]!.allocations[0]!.applySkonto).toBe(true);
    expect(lastDay[0]!.reasons).toContain("SKONTO");
    const nextDay = suggestMatches(tx({ amountCents: payable, remittance: "RE-50123", bookingDate: new Date("2200-05-12T00:00:00.000Z") }), ctx([invoice]));
    expect(nextDay[0]!.confidence).toBe("MOEGLICH");
    expect(nextDay[0]!.allocations[0]!.applySkonto).toBe(false);
  });

  it("zwei Nummern mit passender Summe ergeben eine SPLIT-Zuordnung (SICHER)", () => {
    const list = suggestMatches(tx({ amountCents: 15000, remittance: "RE-50123 RE-50124" }), ctx([inv("RE-50123", 10000), inv("RE-50124", 5000)]));
    const split = list.find((s) => s.reasons.includes("SPLIT"));
    expect(split!.confidence).toBe("SICHER");
    expect(split!.allocations.map((a) => a.amountCents)).toEqual([10000, 5000]);
    expect(split!.restCents).toBe(0);
    expect(list[0]).toBe(split);
  });

  it("zwei Nummern ohne passende Summe ergeben zwei MOEGLICH", () => {
    const list = suggestMatches(tx({ amountCents: 10000, remittance: "RE-50123 RE-50124" }), ctx([inv("RE-50123", 10000), inv("RE-50124", 5000)]));
    expect(list).toHaveLength(2);
    expect(list.every((s) => s.confidence === "MOEGLICH")).toBe(true);
  });

  it("Ueberzahlung: Zuordnung = offener Rest, Rest ausgewiesen, MOEGLICH", () => {
    const [s] = suggestMatches(tx({ amountCents: 15000, remittance: "RE-50123" }), ctx([inv("RE-50123", 11900)]));
    expect(s!.allocations[0]!.amountCents).toBe(11900);
    expect(s!.restCents).toBe(3100);
    expect(s!.confidence).toBe("MOEGLICH");
  });

  it("bereits zugeordneter Anteil des Umsatzes wird abgezogen", () => {
    const [s] = suggestMatches(tx({ amountCents: 20000, allocatedCents: 8100, remittance: "RE-50123" }), ctx([inv("RE-50123", 11900)]));
    expect(s!.confidence).toBe("SICHER");
  });

  it("andere Waehrung, Rueckgaben und voll zugeordnete Umsaetze liefern nichts", () => {
    const c = ctx([inv("RE-50123", 11900)]);
    expect(suggestMatches(tx({ currency: "USD", remittance: "RE-50123" }), c)).toEqual([]);
    expect(suggestMatches(tx({ direction: "DBIT", remittance: "RE-50123" }), c)).toEqual([]);
    expect(suggestMatches(tx({ allocatedCents: 11900, remittance: "RE-50123" }), c)).toEqual([]);
  });

  it("ohne Nummer: Betrag + IBAN-Hinweis ist MOEGLICH, Betrag allein nichts", () => {
    const c = ctx([inv("RE-50123", 11900)], [[HASH, "c1"]]);
    const [s] = suggestMatches(tx({ counterpartyIbanHash: HASH }), c);
    expect(s!.confidence).toBe("MOEGLICH");
    expect(s!.reasons).toEqual(expect.arrayContaining(["AMOUNT", "IBAN_HINT"]));
    expect(suggestMatches(tx(), c)).toEqual([]);
  });

  it("Hinweis eines anderen Kunden zaehlt nicht; Mandats-IBAN und Name zaehlen", () => {
    expect(suggestMatches(tx({ counterpartyIbanHash: HASH }), ctx([inv("RE-50123", 11900)], [[HASH, "c2"]]))).toEqual([]);
    expect(suggestMatches(tx({ counterpartyIbanHash: HASH }), ctx([inv("RE-50123", 11900, { mandateIbanHash: HASH })]))[0]!.reasons).toContain("MANDATE_IBAN");
    expect(suggestMatches(tx({ counterpartyName: "Muster Kundschaft" }), ctx([inv("RE-50123", 11900)]))[0]!.reasons).toContain("NAME");
    expect(suggestMatches(tx({ counterpartyName: "Ganz Anders AG" }), ctx([inv("RE-50123", 11900)]))).toEqual([]);
  });

  it("begrenzt auf max und sortiert stabil nach Score, Faelligkeit, Nummer", () => {
    const invoices = ["RE-60001", "RE-60002", "RE-60003"].map((n, i) => inv(n, 11900, { dueDate: new Date(Date.UTC(2200, 5, 10 - i)) }));
    const list = suggestMatches(tx({ counterpartyName: "Muster Kundschaft" }), ctx(invoices), 2);
    expect(list.map((s) => s.allocations[0]!.number)).toEqual(["RE-60003", "RE-60002"]);
  });
});
