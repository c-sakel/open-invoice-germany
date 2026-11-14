import { describe, expect, it } from "vitest";
import { milliCentsToCents } from "../../src/lib/money";
import { resolveGrossLines, type GrossLineInput } from "../../src/lib/pricing/gross";
import { computeLineNet } from "../../src/lib/pricing/line";
import { computeTaxBreakdown } from "../../src/lib/tax";

const S19 = { taxRate: 19, taxCategory: "S" };

describe("resolveGrossLines", () => {
  it("1 x 9,99 / 19 %: Abweichung -1", () => {
    const r = resolveGrossLines([{ quantityMilli: 1000, unitGrossPriceCents: 999, ...S19 }]);
    expect(r.lines[0].lineNetCents).toBe(839);
    expect(r.lines[0].unitNetPriceMilliCents).toBeNull();
    expect(r.resultGrossCents).toBe(998);
    expect(r.deviationCents).toBe(-1);
  });
  it("2 x 9,99 / 19 %: Milli-Preis 8,395, Abweichung 0", () => {
    const r = resolveGrossLines([{ quantityMilli: 2000, unitGrossPriceCents: 999, ...S19 }]);
    expect(r.lines[0].lineNetCents).toBe(1679);
    expect(r.lines[0].unitNetPriceMilliCents).toBe(839500);
    expect(r.lines[0].unitNetPriceCents).toBe(840);
    expect(r.deviationCents).toBe(0);
  });
  it("5 Zeilen a 1 x 9,99: je Satz statt je Zeile", () => {
    const lines: GrossLineInput[] = Array.from({ length: 5 }, () => ({ quantityMilli: 1000, unitGrossPriceCents: 999, ...S19 }));
    const r = resolveGrossLines(lines);
    const sum = r.lines.reduce((s, l) => s + l.lineNetCents, 0);
    expect(sum).toBe(Math.round((4995 * 100) / 119));
    expect(Math.abs(r.deviationCents)).toBeLessThanOrEqual(1);
    // Gegenprobe: je Zeile gerundet waere 5 x 839 = 4195 Netto -> Brutto 4990 (Abweichung -5)
    const perLine = 5 * 839 + Math.round((5 * 839 * 19) / 100);
    expect(Math.abs(perLine - 4995)).toBeGreaterThan(Math.abs(r.deviationCents));
  });
  it("zwei Saetze: Abweichung <= 2", () => {
    const r = resolveGrossLines([
      { quantityMilli: 1000, unitGrossPriceCents: 999, ...S19 },
      { quantityMilli: 1000, unitGrossPriceCents: 999, taxRate: 7, taxCategory: "S" },
    ]);
    expect(Math.abs(r.deviationCents)).toBeLessThanOrEqual(2);
  });
  it("Satz 0 (E): Netto = Brutto", () => {
    const r = resolveGrossLines([{ quantityMilli: 3000, unitGrossPriceCents: 333, taxRate: 0, taxCategory: "E" }]);
    expect(r.lines[0].lineNetCents).toBe(999);
    expect(r.deviationCents).toBe(0);
  });
  it("lineGrossCents statt Stueckpreis", () => {
    const r = resolveGrossLines([{ quantityMilli: 3000, lineGrossCents: 1190, ...S19 }]);
    expect(r.targetGrossCents).toBe(1190);
    expect(r.lines[0].lineNetCents).toBe(1000);
  });
  it("unloesbarer Milli-Preis: exact false, Abweichung korrekt", () => {
    // Menge 2.000 Stueck, Netto 1 Cent -> 0,0005 EUR = 50 Milli-Cent loesbar; 3 Cent aber 150 -> loesbar;
    // gesucht: Menge so, dass kein Preis passt (Netto-Spruenge > 1 Cent je Milli-Cent-Schritt)
    const r = resolveGrossLines([{ quantityMilli: 2_000_000_000, lineGrossCents: 100_000_001, ...S19 }]);
    const calc = computeLineNet({
      quantityMilli: 2_000_000_000,
      unitNetPriceCents: r.lines[0].unitNetPriceCents,
      unitNetPriceMilliCents: r.lines[0].unitNetPriceMilliCents,
    });
    expect(calc.lineNetCents).toBe(r.lines[0].lineNetCents);
    expect(r.deviationCents).toBe(r.resultGrossCents - r.targetGrossCents);
    expect(r.lines[0].exact).toBe(false);
  });

  it("Property: 2.000 Faelle", () => {
    let seed = 20261114;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const rates = [0, 7, 19];
    for (let c = 0; c < 2000; c++) {
      const count = 1 + rnd(6);
      const lines: GrossLineInput[] = Array.from({ length: count }, () => {
        const rate = rates[rnd(3)];
        return { quantityMilli: (1 + rnd(1000)) * 1000, unitGrossPriceCents: 1 + rnd(100_000), taxRate: rate, taxCategory: rate === 0 ? "E" : "S" };
      });
      const r = resolveGrossLines(lines);
      const keys = new Set(lines.map((l) => `${l.taxCategory}:${l.taxRate}`));
      expect(Math.abs(r.deviationCents)).toBeLessThanOrEqual(keys.size);
      r.lines.forEach((rl, i) => {
        const net = computeLineNet({ quantityMilli: lines[i].quantityMilli, unitNetPriceCents: rl.unitNetPriceCents, unitNetPriceMilliCents: rl.unitNetPriceMilliCents }).lineNetCents;
        expect(net).toBe(rl.lineNetCents);
        expect(rl.unitNetPriceCents).toBe(milliCentsToCents(rl.unitNetPriceMilliCents ?? rl.unitNetPriceCents * 1000));
      });
      const tb = computeTaxBreakdown(r.lines.map((rl, i) => ({ lineNetCents: rl.lineNetCents, taxRate: lines[i].taxRate, taxCategory: lines[i].taxCategory })));
      expect(r.resultGrossCents).toBe(tb.grossTotalCents);
    }
  });
});
