import { describe, expect, it } from "vitest";
import { normalizeDecimalString, parseXmlAmountCents } from "@/domain/incoming/amount";

describe("parseXmlAmountCents", () => {
  it("liest Betraege ohne Float", () => {
    expect(parseXmlAmountCents("1234.56")).toEqual({ cents: 123456, overflow: false });
    expect(parseXmlAmountCents("0.1")).toEqual({ cents: 10, overflow: false });
    expect(parseXmlAmountCents("7")).toEqual({ cents: 700, overflow: false });
    expect(parseXmlAmountCents(".5")).toEqual({ cents: 50, overflow: false });
    expect(parseXmlAmountCents(" 12.30 ")).toEqual({ cents: 1230, overflow: false });
  });

  it("rundet ab der dritten Nachkommastelle kaufmaennisch vom Betrag weg", () => {
    expect(parseXmlAmountCents("-0.005")).toEqual({ cents: -1, overflow: false });
    expect(parseXmlAmountCents("0.005")).toEqual({ cents: 1, overflow: false });
    expect(parseXmlAmountCents("0.004")).toEqual({ cents: 0, overflow: false });
    expect(parseXmlAmountCents("1.2349")).toEqual({ cents: 123, overflow: false });
    expect(parseXmlAmountCents("2.675")).toEqual({ cents: 268, overflow: false });
  });

  it("lehnt ungueltige Schreibweisen ab", () => {
    for (const bad of ["1e3", "1,00", " ", "", "12.3.4", "abc", "1.", "--1", "0x10", "NaN"]) {
      expect(parseXmlAmountCents(bad)).toEqual({ cents: null, overflow: false });
    }
    expect(parseXmlAmountCents(null)).toEqual({ cents: null, overflow: false });
    expect(parseXmlAmountCents(undefined)).toEqual({ cents: null, overflow: false });
  });

  it("meldet Ueberlauf ab 21.474.836,48", () => {
    expect(parseXmlAmountCents("21474836.47")).toEqual({ cents: 2147483647, overflow: false });
    expect(parseXmlAmountCents("-21474836.47")).toEqual({ cents: -2147483647, overflow: false });
    expect(parseXmlAmountCents("21474836.48")).toEqual({ cents: null, overflow: true });
    expect(parseXmlAmountCents("21474836.475")).toEqual({ cents: null, overflow: true });
    expect(parseXmlAmountCents("9".repeat(80))).toEqual({ cents: null, overflow: true });
  });
});

describe("normalizeDecimalString", () => {
  it("normalisiert nur die Schreibweise", () => {
    expect(normalizeDecimalString("0.00200")).toBe("0.00200");
    expect(normalizeDecimalString("+3")).toBe("3");
    expect(normalizeDecimalString(".5")).toBe("0.5");
    expect(normalizeDecimalString("-0")).toBe("0");
    expect(normalizeDecimalString("-1.234")).toBe("-1.234");
  });
  it("lehnt Ungueltiges ab", () => {
    for (const bad of ["1e3", "1,5", "", " ", "x", "1.2.3"]) expect(normalizeDecimalString(bad)).toBeNull();
  });
});

describe("parseXmlAmountCents Laenge", () => {
  it("sehr lange Zeichenfolgen sind ungueltig, nicht Ueberlauf", () => {
    expect(parseXmlAmountCents("9".repeat(5000))).toEqual({ cents: null, overflow: false });
  });
});
