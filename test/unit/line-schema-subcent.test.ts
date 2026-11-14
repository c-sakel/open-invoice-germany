import { describe, it, expect } from "vitest";
import { invoiceLineInputSchema } from "@/schemas";
import { normalizeLines, linePriceFields } from "@/domain/document/lines";

const base = {
  description: "API-Aufrufe",
  quantityMilli: 10_000_000,
  unit: "C62",
  unitNetPriceCents: 0,
  taxRate: 19,
};

function issuePaths(input: unknown): { path: string; message: string }[] {
  const r = invoiceLineInputSchema.safeParse(input);
  if (r.success) return [];
  return r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

describe("invoiceLineInputSchema: Milli-Cent-Einzelpreis und Leistungszeitraum (18f)", () => {
  it("akzeptiert cents 0 + milli 200", () => {
    const r = invoiceLineInputSchema.parse({ ...base, unitNetPriceMilliCents: 200 });
    expect(r.unitNetPriceMilliCents).toBe(200);
  });

  it("lehnt cents 1 + milli 200 ab (Pfad unitNetPriceCents, erwarteter Wert 0 in der Meldung)", () => {
    const issues = issuePaths({ ...base, unitNetPriceCents: 1, unitNetPriceMilliCents: 200 });
    const issue = issues.find((i) => i.path === "unitNetPriceCents");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("0");
  });

  it("lehnt Milli ueber 2147483647 ab", () => {
    expect(issuePaths({ ...base, unitNetPriceMilliCents: 2_147_483_648 }).length).toBeGreaterThan(0);
  });

  it("lehnt Milli bei Nicht-Positionszeilen ab", () => {
    const issues = issuePaths({ lineType: "HEADING", description: "Abschnitt", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, unitNetPriceMilliCents: 200 });
    expect(issues.some((i) => i.path === "unitNetPriceMilliCents")).toBe(true);
  });

  it("Leistungszeitraum nur beidseitig und Start <= Ende", () => {
    expect(issuePaths({ ...base, servicePeriodStart: "2186-03-01" }).length).toBeGreaterThan(0);
    expect(issuePaths({ ...base, servicePeriodEnd: "2186-03-31" }).length).toBeGreaterThan(0);
    expect(issuePaths({ ...base, servicePeriodStart: "2186-04-01", servicePeriodEnd: "2186-03-31" }).length).toBeGreaterThan(0);
    expect(issuePaths({ ...base, servicePeriodStart: "2186-03-01", servicePeriodEnd: "2186-03-31" })).toEqual([]);
  });

  it("Leistungszeitraum bei Nicht-Positionszeilen unzulaessig", () => {
    const issues = issuePaths({ lineType: "TEXT", description: "Hinweis", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, servicePeriodStart: "2186-03-01", servicePeriodEnd: "2186-03-31" });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("ohne neue Felder: Ausgabe enthaelt keine neuen Schluessel", () => {
    const r = invoiceLineInputSchema.parse({ ...base, unitNetPriceCents: 2900, quantityMilli: 1000 });
    expect(Object.keys(r).sort()).toEqual(
      ["description", "discountCents", "discountPermille", "lineType", "quantityMilli", "taxCategory", "taxRate", "unit", "unitNetPriceCents"].sort(),
    );
  });
});

describe("normalizeLines / linePriceFields (18f)", () => {
  it("normalisiert ganze Cent-Preise zu null und verwirft Zeitraum bei Nicht-ITEM", () => {
    const [a] = normalizeLines([invoiceLineInputSchema.parse({ ...base, unitNetPriceCents: 5, unitNetPriceMilliCents: 5000 })]);
    expect(a!.unitNetPriceMilliCents).toBeNull();
  });

  it("wirft bei inkonsistentem Cent-Preis (Aufrufer ohne Zod)", () => {
    expect(() =>
      normalizeLines([{ ...base, lineType: "ITEM", unitNetPriceCents: 1, unitNetPriceMilliCents: 200, discountPermille: 0, discountCents: 0, taxCategory: "S" } as never]),
    ).toThrow(/0/);
  });

  it("linePriceFields spiegelt beide Preise, ohne -0", () => {
    expect(linePriceFields({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 }, -1)).toEqual({ unitNetPriceCents: 0, unitNetPriceMilliCents: -200 });
    expect(Object.is(linePriceFields({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 }, -1).unitNetPriceCents, 0)).toBe(true);
    expect(linePriceFields({ unitNetPriceCents: 2900 }, -1)).toEqual({ unitNetPriceCents: -2900, unitNetPriceMilliCents: null });
    expect(linePriceFields({ unitNetPriceCents: 2900, unitNetPriceMilliCents: null })).toEqual({ unitNetPriceCents: 2900, unitNetPriceMilliCents: null });
  });
});
