import { describe, it, expect } from "vitest";
import { monthlyRunRateCents } from "@/domain/reporting/recurring-run-rate";

const one = (cents: number, discountPermille = 0) => [{ quantityMilli: 1000, unitNetPriceCents: cents, discountPermille }];

describe("monthlyRunRateCents", () => {
  it("MONTHLY x1 = Zeilennetto", () => expect(monthlyRunRateCents(one(10000), "MONTHLY", 1)).toBe(10000));
  it("WEEKLY = 52/12", () => expect(monthlyRunRateCents(one(10000), "WEEKLY", 1)).toBe(43333));
  it("QUARTERLY = 1/3", () => expect(monthlyRunRateCents(one(10000), "QUARTERLY", 1)).toBe(3333));
  it("YEARLY = 1/12", () => expect(monthlyRunRateCents(one(120000), "YEARLY", 1)).toBe(10000));
  it("intervalCount 2 halbiert", () => expect(monthlyRunRateCents(one(10000), "MONTHLY", 2)).toBe(5000));
  it("DAY = 365/12", () => expect(monthlyRunRateCents(one(100), "DAY", 1)).toBe(3042));
  it("Positionsrabatt 100 Promille", () => expect(monthlyRunRateCents(one(10000, 100), "MONTHLY", 1)).toBe(9000));
  it("rundet einmal half-up (0,5 -> 1)", () => expect(monthlyRunRateCents(one(6), "YEARLY", 1)).toBe(1));
  it("summiert Zeilen vor der Skalierung", () =>
    expect(monthlyRunRateCents([...one(1), ...one(1), ...one(1), ...one(1), ...one(1), ...one(1)], "YEARLY", 1)).toBe(1));
  it("beruecksichtigt den Einzelpreis in tausendstel Cent (Phase 18f)", () => {
    // 10.000 Stueck a 0,002 EUR (200 Milli-Cent) = 20,00 EUR; der Cent-Preis allein waere 0.
    const lines = [{ quantityMilli: 10_000_000, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, discountPermille: 0 }];
    expect(monthlyRunRateCents(lines, "MONTHLY", 1)).toBe(2000);
  });
  it("Verbrauchszeile (Menge 0) zaehlt mit 0", () => {
    const lines = [...one(2900), { quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, discountPermille: 0 }];
    expect(monthlyRunRateCents(lines, "MONTHLY", 1)).toBe(2900);
  });
  it("unbekanntes Intervall wirft", () => expect(() => monthlyRunRateCents(one(1), "HOURLY", 1)).toThrow());
});
