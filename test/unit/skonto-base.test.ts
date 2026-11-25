import { describe, it, expect } from "vitest";
import { skontoBaseCents, skontoTermsForInvoice } from "@/domain/invoice/amounts";
import { skontoTerms, xrechnungSkontoNote } from "@/lib/pricing/skonto";
import { parseSkontoTerms } from "@/domain/incoming/skonto";

const XR_SKONTO_REGEX = /^#(SKONTO)#TAGE=([0-9]+#PROZENT=[0-9]+\.[0-9]{2})(#BASISBETRAG=-?[0-9]+\.[0-9]{2})?#$/;
const issueDate = new Date(Date.UTC(2034, 5, 3));

const terms = (gross: number) =>
  skontoTerms({ issueDate, grossTotalCents: gross, skonto1Permille: 20, skonto1Days: 7, skonto2Permille: null, skonto2Days: null });

describe("skontoBaseCents", () => {
  it("nutzt den Zahlbetrag, wenn keine eingefrorene Basis vorliegt", () => {
    expect(skontoBaseCents({ grossTotalCents: 1190000, payableCents: 595000 })).toBe(595000);
  });
  it("eingefrorene Basis hat Vorrang", () => {
    expect(skontoBaseCents({ grossTotalCents: 1190000, payableCents: 595000, skontoBaseCents: 1190000 })).toBe(1190000);
  });
  it("ohne Zahlbetrag das Gesamtbrutto", () => {
    expect(skontoBaseCents({ grossTotalCents: 1190000, payableCents: null })).toBe(1190000);
    expect(skontoBaseCents({ grossTotalCents: 1190000, payableCents: null, skontoBaseCents: null })).toBe(1190000);
  });
});

describe("Skonto auf Zahlbetrag (F-01)", () => {
  it("2 % auf 5.950,00 -> 119,00 Skonto, 5.831,00 Zahlbetrag", () => {
    const [t] = terms(595000);
    expect(t.amountCents).toBe(11900);
    expect(t.payableCents).toBe(583100);
  });
});

describe("xrechnungSkontoNote mit Basisbetrag", () => {
  it("ohne opts unveraendert", () => {
    expect(xrechnungSkontoNote(terms(595000), "x")).toBe("#SKONTO#TAGE=7#PROZENT=2.00#\nx");
  });
  it("mit basisCents haengt BASISBETRAG an und passt auf die XSL-Regel", () => {
    const out = xrechnungSkontoNote(terms(595000), "x", { basisCents: 1190000 });
    const line = out.split("\n")[0];
    expect(line).toBe("#SKONTO#TAGE=7#PROZENT=2.00#BASISBETRAG=11900.00#");
    expect(XR_SKONTO_REGEX.test(line)).toBe(true);
  });
  it("kleine Betraege mit fuehrender Null", () => {
    expect(xrechnungSkontoNote(terms(595000), "x", { basisCents: 5 })).toContain("#BASISBETRAG=0.05#");
    expect(xrechnungSkontoNote(terms(595000), "x", { basisCents: 0 })).toContain("#BASISBETRAG=0.00#");
  });
  it("negative oder nicht ganzzahlige Basis wird abgelehnt", () => {
    expect(() => xrechnungSkontoNote(terms(595000), "x", { basisCents: -1 })).toThrow();
    expect(() => xrechnungSkontoNote(terms(595000), "x", { basisCents: 1.5 })).toThrow();
  });
  it("Rundlauf mit parseSkontoTerms", () => {
    const out = xrechnungSkontoNote(terms(595000), "Zahlbar netto.", { basisCents: 1190000 });
    const parsed = parseSkontoTerms(out);
    expect(parsed.terms).toHaveLength(1);
    expect(parsed.terms[0].basisCents).toBe(1190000);
    expect(parsed.terms[0].percentBp).toBe(200);
    expect(parsed.freeText).toBe("Zahlbar netto.");
  });
});

describe("skontoTermsForInvoice (Bestand mit eingefrorener Basis)", () => {
  const inv = {
    grossTotalCents: 1190000, payableCents: 595000, skontoBaseCents: 1190000, issueDate,
    skonto1Permille: 20, skonto1Days: 7, skonto2Permille: null, skonto2Days: null,
  };
  it("ohne Teilzahlung: Zahlbetrag = offener Rest minus Skontobetrag", () => {
    const [t] = skontoTermsForInvoice(inv, 595000);
    expect(t.amountCents).toBe(23800);
    expect(t.payableCents).toBe(571200);
  });
  it("Teilzahlung, offener Rest kleiner als Skontobetrag: kein Vorschlag, nie negativ", () => {
    expect(skontoTermsForInvoice(inv, 20000)).toEqual([]);
  });
  it("Teilzahlung, Rest groesser als Skontobetrag: Zahlbetrag nicht negativ", () => {
    const [t] = skontoTermsForInvoice(inv, 100000);
    expect(t.payableCents).toBe(76200);
  });
});
