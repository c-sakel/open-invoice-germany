/**
 * Phase 18f Task 6: resolvePriceInput (Sub-Cent- und Bruttopreise der API) und euroToUnitPrice (MCP).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolvePriceInput, assertGrossPayment, grossResponseFields, GrossDeviationError } from "@/domain/document/price-input";
import { euroToUnitPrice, euroToGrossCents, ToolError } from "@/mcp/tools/context";

const base = { customerId: "c1", taxScheme: "REGULAR" };
const item = (extra: Record<string, unknown>) => ({ description: "X", quantityMilli: 1000, unit: "C62", taxRate: 19, ...extra });

function issues(fn: () => unknown): { path: (string | number)[]; message: string }[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof z.ZodError) return e.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message }));
    throw e;
  }
  throw new Error("kein ZodError");
}
const lines = (r: { body: unknown }) => (r.body as { lines: Record<string, unknown>[] }).lines;

describe("resolvePriceInput", () => {
  it("nur Milli-Preis: Cent ergibt sich, Milli bleibt", () => {
    const r = resolvePriceInput({ ...base, lines: [item({ unitNetPriceMilliCents: 200 })] });
    expect(r.mode).toBe("NET");
    expect(lines(r)[0]).toMatchObject({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 });
  });

  it("Milli auf ganzem Cent wird normalisiert (kein Milli-Feld)", () => {
    const r = resolvePriceInput({ ...base, lines: [item({ unitNetPriceMilliCents: 1000 })] });
    expect(lines(r)[0]).toEqual(item({ unitNetPriceCents: 1 }));
  });

  it("Cent + Milli inkonsistent -> ZodError am Cent-Feld", () => {
    const i = issues(() => resolvePriceInput({ ...base, lines: [item({ unitNetPriceCents: 5, unitNetPriceMilliCents: 200 })] }));
    expect(i[0].path).toEqual(["lines", 0, "unitNetPriceCents"]);
  });

  it("Cent + Milli konsistent bleibt gueltig", () => {
    const r = resolvePriceInput({ ...base, lines: [item({ unitNetPriceCents: 1, unitNetPriceMilliCents: 1499 })] });
    expect(lines(r)[0]).toMatchObject({ unitNetPriceCents: 1, unitNetPriceMilliCents: 1499 });
  });

  it("Cent + Brutto -> genau eine Preisangabe", () => {
    const i = issues(() => resolvePriceInput({ ...base, lines: [item({ unitNetPriceCents: 5, unitGrossPriceCents: 6 })] }));
    expect(i[0].path).toEqual(["lines", 0, "unitGrossPriceCents"]);
    expect(i[0].message).toContain("Genau eine Preisangabe");
  });

  it("unitGross + lineGross zusammen -> Fehler", () => {
    const i = issues(() => resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 6, lineGrossCents: 6 })] }));
    expect(i[0].message).toContain("Genau eine Preisangabe");
  });

  it("Brutto- und Nettozeilen gemischt -> Fehler an der Nettozeile", () => {
    const i = issues(() => resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 999 }), item({ unitNetPriceCents: 100 })] }));
    expect(i).toHaveLength(1);
    expect(i[0].path).toEqual(["lines", 1]);
  });

  it("Brutto mit Positionsrabatt oder Belegrabatt -> Fehler", () => {
    const a = issues(() => resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 999, discountPermille: 100 })] }));
    expect(a[0].path).toEqual(["lines", 0, "discountPermille"]);
    const b = issues(() => resolvePriceInput({ ...base, documentDiscountCents: 50, lines: [item({ unitGrossPriceCents: 999 })] }));
    expect(b[0].path).toEqual(["documentDiscountCents"]);
    const c = issues(() => resolvePriceInput({ ...base, documentChargePermille: 10, lines: [item({ unitGrossPriceCents: 999 })] }));
    expect(c[0].path).toEqual(["documentChargePermille"]);
  });

  it("Brutto braucht Menge > 0", () => {
    const i = issues(() => resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 999, quantityMilli: 0 })] }));
    expect(i[0].path).toEqual(["lines", 0, "quantityMilli"]);
  });

  it("negativer oder krummer Bruttopreis -> Fehler am Feld", () => {
    expect(issues(() => resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: -1 })] }))[0].path).toEqual(["lines", 0, "unitGrossPriceCents"]);
    expect(issues(() => resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 1.5 })] }))[0].path).toEqual(["lines", 0, "unitGrossPriceCents"]);
  });

  it("Milli ueber Int32 -> Fehler", () => {
    const i = issues(() => resolvePriceInput({ ...base, lines: [item({ unitNetPriceMilliCents: 2147483648 })] }));
    expect(i[0].path).toEqual(["lines", 0, "unitNetPriceMilliCents"]);
  });

  it("HEADING ohne Preis bleibt neben Bruttozeilen", () => {
    const heading = { lineType: "HEADING", description: "Titel", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0 };
    const r = resolvePriceInput({ ...base, lines: [heading, item({ unitGrossPriceCents: 999 })] });
    expect(r.mode).toBe("GROSS");
    expect(lines(r)[0]).toEqual(heading);
  });

  it("1 x 9,99 brutto: Ziel 999, Abweichung -1; Bruttofelder entfernt", () => {
    const r = resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 999 })] });
    expect(r.mode).toBe("GROSS");
    expect(r.grossTargetCents).toBe(999);
    expect(r.predictedDeviationCents).toBe(-1);
    const l = lines(r)[0];
    expect(l).not.toHaveProperty("unitGrossPriceCents");
    expect(l).not.toHaveProperty("lineGrossCents");
    expect(typeof l.unitNetPriceCents).toBe("number");
  });

  it("2 x 9,99 brutto: keine Abweichung, Milli-Preis 839500", () => {
    const r = resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 999, quantityMilli: 2000 })] });
    expect(r.grossTargetCents).toBe(1998);
    expect(r.predictedDeviationCents).toBe(0);
    expect(lines(r)[0]).toMatchObject({ unitNetPriceCents: 840, unitNetPriceMilliCents: 839500 });
  });

  it("lineGrossCents hat eigenes Ziel", () => {
    const r = resolvePriceInput({ ...base, lines: [item({ lineGrossCents: 1998, quantityMilli: 2000 })] });
    expect(r.grossTargetCents).toBe(1998);
    expect(r.predictedDeviationCents).toBe(0);
  });

  it("ohne lines (Teil-Update): Body unveraendert (Referenz)", () => {
    const body = { subject: "x" };
    const r = resolvePriceInput(body);
    expect(r.mode).toBe("NET");
    expect(r.body).toBe(body);
    expect(r.grossTargetCents).toBeNull();
  });

  it("reine Nettozeilen: Zeilen unveraendert", () => {
    const l = item({ unitNetPriceCents: 1234, unitNetPriceMilliCents: null });
    const r = resolvePriceInput({ ...base, lines: [l] });
    expect(r.mode).toBe("NET");
    expect(lines(r)[0]).toBe(l);
  });
});

describe("Hilfen der Antwort", () => {
  it("assertGrossPayment: bei Abweichung nur das tatsaechliche Brutto", () => {
    const r = resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 999 })] });
    expect(() => assertGrossPayment(r, 999)).toThrow(GrossDeviationError);
    expect(() => assertGrossPayment(r, 998)).not.toThrow();
    expect(() => assertGrossPayment(r, undefined)).not.toThrow();
  });
  it("grossResponseFields: leer bei Netto, sonst Ziel und tatsaechliche Abweichung", () => {
    expect(grossResponseFields(resolvePriceInput({ ...base, lines: [item({ unitNetPriceCents: 5 })] }), 6)).toEqual({});
    const g = resolvePriceInput({ ...base, lines: [item({ unitGrossPriceCents: 999 })] });
    expect(grossResponseFields(g, 998)).toMatchObject({ grossTargetCents: 999, grossDeviationCents: -1, grossExact: false });
  });
});

describe("euroToUnitPrice (MCP)", () => {
  it("Sub-Cent exakt", () => {
    expect(euroToUnitPrice(0.002)).toEqual({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 });
    expect(euroToUnitPrice(8.395)).toEqual({ unitNetPriceCents: 840, unitNetPriceMilliCents: 839500 });
    expect(euroToUnitPrice(0.00001)).toEqual({ unitNetPriceCents: 0, unitNetPriceMilliCents: 1 });
  });
  it("ganze Cent ohne Milli, auch grosse und negative", () => {
    expect(euroToUnitPrice(12.5)).toEqual({ unitNetPriceCents: 1250, unitNetPriceMilliCents: null });
    expect(euroToUnitPrice(1234567890.12)).toEqual({ unitNetPriceCents: 123456789012, unitNetPriceMilliCents: null });
    expect(euroToUnitPrice(-5)).toEqual({ unitNetPriceCents: -500, unitNetPriceMilliCents: null });
  });
  it("mehr als 5 Stellen -> ToolError, nie still gerundet", () => {
    expect(() => euroToUnitPrice(0.0000001)).toThrow(ToolError);
    expect(() => euroToUnitPrice(0.0000001)).toThrow("höchstens 5 Nachkommastellen");
    expect(() => euroToUnitPrice(1.234567)).toThrow(ToolError);
  });
  it("Sub-Cent ueber der Int32-Grenze und negativ -> ToolError", () => {
    expect(() => euroToUnitPrice(30000.001)).toThrow(ToolError);
    expect(() => euroToUnitPrice(-0.002)).toThrow(ToolError);
  });
  it("Bruttopreis nur mit 2 Stellen", () => {
    expect(euroToGrossCents(9.99)).toBe(999);
    expect(() => euroToGrossCents(9.999)).toThrow(ToolError);
  });
});
