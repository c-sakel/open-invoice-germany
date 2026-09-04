import { describe, it, expect } from "vitest";
import { computeTaxBreakdown, defaultCategoryForScheme, ZERO_TAX_SCHEMES } from "@/lib/tax";

describe("tax", () => {
  it("gruppiert nach Satz/Kategorie und rundet pro Gruppe (EN 16931)", () => {
    const t = computeTaxBreakdown([
      { lineNetCents: 10000, taxRate: 19, taxCategory: "S" },
      { lineNetCents: 5000, taxRate: 19, taxCategory: "S" },
      { lineNetCents: 10000, taxRate: 7, taxCategory: "S" },
    ]);
    expect(t.netTotalCents).toBe(25000);
    // 19 % von 15000 = 2850 ; 7 % von 10000 = 700
    expect(t.taxTotalCents).toBe(3550);
    expect(t.grossTotalCents).toBe(28550);
    expect(t.breakdown).toHaveLength(2);
  });

  it("Reverse Charge / 0 % erzeugt keine Steuer", () => {
    const t = computeTaxBreakdown([{ lineNetCents: 50000, taxRate: 0, taxCategory: "AE" }]);
    expect(t.taxTotalCents).toBe(0);
    expect(t.grossTotalCents).toBe(50000);
  });
});

describe("defaultCategoryForScheme", () => {
  it("REGULAR → S (Standard)", () => {
    expect(defaultCategoryForScheme("REGULAR")).toBe("S");
  });

  it("KLEINUNTERNEHMER → E (steuerbefreit)", () => {
    expect(defaultCategoryForScheme("KLEINUNTERNEHMER")).toBe("E");
  });

  it("REVERSE_CHARGE → AE (Reverse Charge)", () => {
    expect(defaultCategoryForScheme("REVERSE_CHARGE")).toBe("AE");
  });

  it("IG_LIEFERUNG → K (innergemeinschaftlich)", () => {
    expect(defaultCategoryForScheme("IG_LIEFERUNG")).toBe("K");
  });

  it("IG_LEISTUNG → AE (Reverse Charge § 13b)", () => {
    expect(defaultCategoryForScheme("IG_LEISTUNG")).toBe("AE");
  });

  it("DRITTLAND_LEISTUNG → O (Out of scope)", () => {
    expect(defaultCategoryForScheme("DRITTLAND_LEISTUNG")).toBe("O");
  });

  it("DIFFERENZ → S (Differenzbesteuerung, aber Standard-Satz)", () => {
    expect(defaultCategoryForScheme("DIFFERENZ")).toBe("S");
  });
});

describe("ZERO_TAX_SCHEMES", () => {
  it("enthält alle befreiten Schemata", () => {
    expect(ZERO_TAX_SCHEMES.has("KLEINUNTERNEHMER")).toBe(true);
    expect(ZERO_TAX_SCHEMES.has("REVERSE_CHARGE")).toBe(true);
    expect(ZERO_TAX_SCHEMES.has("IG_LIEFERUNG")).toBe(true);
    expect(ZERO_TAX_SCHEMES.has("IG_LEISTUNG")).toBe(true);
    expect(ZERO_TAX_SCHEMES.has("DRITTLAND_LEISTUNG")).toBe(true);
  });

  it("REGULAR ist nicht enthalten (19/7/0 wählbar)", () => {
    expect(ZERO_TAX_SCHEMES.has("REGULAR")).toBe(false);
  });
});

describe("computeTaxBreakdown — Drittland-Leistung (Z, 0%)", () => {
  it("Nullsatz erzeugt keine Steuer", () => {
    const t = computeTaxBreakdown([
      { lineNetCents: 100000, taxRate: 0, taxCategory: "Z" },
    ]);
    expect(t.netTotalCents).toBe(100000);
    expect(t.taxTotalCents).toBe(0);
    expect(t.grossTotalCents).toBe(100000);
    expect(t.breakdown).toHaveLength(1);
    expect(t.breakdown[0].taxCategory).toBe("Z");
  });
});
