import { describe, expect, it } from "vitest";
import { computeLineNet, lineGrossCents } from "../../src/lib/pricing/line";
import { PricingError } from "../../src/lib/pricing/errors";

describe("computeLineNet mit Milli-Preis", () => {
  it("Bestandsrechnung ohne Milli bleibt unveraendert", () => {
    expect(computeLineNet({ quantityMilli: 2500, unitNetPriceCents: 10000, discountPermille: 100, discountCents: 500 }).lineNetCents).toBe(22000);
    expect(computeLineNet({ quantityMilli: 2500, unitNetPriceCents: 10000, unitNetPriceMilliCents: null }).grossLineCents).toBe(25000);
  });
  it("10.000 x 0,002 EUR = 20,00 EUR", () => {
    expect(computeLineNet({ quantityMilli: 10_000_000, unitNetPriceCents: 0, unitNetPriceMilliCents: 200 }).lineNetCents).toBe(2000);
  });
  it("rundet kleine Mengen", () => {
    expect(computeLineNet({ quantityMilli: 1234, unitNetPriceCents: 0, unitNetPriceMilliCents: 1234 }).lineNetCents).toBe(2);
  });
  it("Rabatt wirkt auf das Milli-Brutto", () => {
    const r = computeLineNet({ quantityMilli: 1_000_000, unitNetPriceCents: 2, unitNetPriceMilliCents: 1500, discountPermille: 100 });
    expect(r.grossLineCents).toBe(1500);
    expect(r.lineNetCents).toBe(1350);
  });
  it("lehnt negative und zu grosse Werte ab", () => {
    expect(() => computeLineNet({ quantityMilli: 1000, unitNetPriceCents: 0, unitNetPriceMilliCents: -1 })).toThrow(PricingError);
    expect(() => computeLineNet({ quantityMilli: 1_000_000_000, unitNetPriceCents: 0, unitNetPriceMilliCents: 2_147_483_647 })).toThrow(PricingError);
  });
  it("lineGrossCents == grossLineCents", () => {
    const l = { quantityMilli: 7_777, unitNetPriceCents: 1, unitNetPriceMilliCents: 1234 };
    expect(lineGrossCents(l)).toBe(computeLineNet(l).grossLineCents);
  });
});
