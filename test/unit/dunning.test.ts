import { describe, it, expect } from "vitest";
import { computeDunning, computeInterestSegments, daysBetween, DEFAULT_BASE_RATE_BP } from "@/lib/dunning";
import { roundHalfUp } from "@/lib/money";
import type { BaseRateEntry } from "@/domain/dunning/base-rate";

describe("Verzugszins (§ 288 BGB)", () => {
  it("B2B: 9 Pp über Basiszins, taggenau + 40-€-Pauschale", () => {
    const r = computeDunning({ openAmountCents: 100000, daysOverdue: 30, isConsumer: false, applyFlatFee: true });
    expect(r.pointsBp).toBe(900);
    const expectedInterest = Math.round((100000 * (DEFAULT_BASE_RATE_BP + 900) * 30) / (10000 * 365));
    expect(r.interestCents).toBe(expectedInterest);
    expect(r.flatFee40Cents).toBe(4000);
    expect(r.totalCents).toBe(100000 + expectedInterest + 4000);
  });

  it("B2C: 5 Pp, KEINE 40-€-Pauschale", () => {
    const r = computeDunning({ openAmountCents: 100000, daysOverdue: 30, isConsumer: true, applyFlatFee: true });
    expect(r.pointsBp).toBe(500);
    expect(r.flatFee40Cents).toBe(0);
  });

  it("daysOverdue = 0 ergibt 0 Cent Zinsen (Fix-Welle Task 3, Regressionsschutz)", () => {
    const r = computeDunning({ openAmountCents: 100000, daysOverdue: 0, isConsumer: false, applyFlatFee: false });
    expect(r.interestCents).toBe(0);
  });

  it("daysBetween rechnet ganze Tage", () => {
    expect(daysBetween(new Date("2026-06-01"), new Date("2026-06-09"))).toBe(8);
  });
});

// Phase 14a, Task 3 (R7): der Basiszinssatz aendert sich zum 1.1./1.7. — liegt die
// Verzugsperiode ueber einer solchen Grenze, wird je Abschnitt (Halbjahr) mit dem dort
// gueltigen Satz gerechnet; gerundet wird EINMAL ueber die exakte Summe, nicht je Abschnitt.
describe("computeInterestSegments (Verzugszins ueber Basiszins-Halbjahresgrenzen)", () => {
  it("ein Abschnitt (kein Satzwechsel in der Periode) entspricht dem Ergebnis von computeDunning (Altergebnis)", () => {
    const from = new Date("2026-01-10T00:00:00.000Z");
    const to = new Date("2026-02-09T00:00:00.000Z"); // 30 Tage
    const rates: BaseRateEntry[] = [{ validFrom: new Date("2025-01-01T00:00:00.000Z"), rateBp: DEFAULT_BASE_RATE_BP }];
    const seg = computeInterestSegments({ openAmountCents: 100000, from, to, isConsumer: false, rates });
    expect(seg.segments).toHaveLength(1);
    expect(seg.segments[0]!.days).toBe(30);
    const expected = computeDunning({ openAmountCents: 100000, daysOverdue: 30, isConsumer: false, applyFlatFee: false });
    expect(seg.interestCents).toBe(expected.interestCents);
    expect(seg.baseRateBpWeighted).toBe(DEFAULT_BASE_RATE_BP);
  });

  it("zwei Abschnitte bei Satzwechsel zum 01.07. innerhalb der Periode ergeben die Summe der Einzelabschnitte (exakte Bruch-Summe, einmal gerundet)", () => {
    const from = new Date("2026-05-01T00:00:00.000Z");
    const to = new Date("2026-09-15T00:00:00.000Z");
    const cut = new Date("2026-07-01T00:00:00.000Z");
    const rates: BaseRateEntry[] = [
      { validFrom: new Date("2026-01-01T00:00:00.000Z"), rateBp: 127 },
      { validFrom: cut, rateBp: 188 },
    ];
    const seg = computeInterestSegments({ openAmountCents: 23800, from, to, isConsumer: false, rates });
    expect(seg.segments).toHaveLength(2);
    const days1 = daysBetween(from, cut);
    const days2 = daysBetween(cut, to);
    expect(seg.segments[0]).toMatchObject({ days: days1, baseRateBp: 127, pointsBp: 900 });
    expect(seg.segments[1]).toMatchObject({ days: days2, baseRateBp: 188, pointsBp: 900 });
    const exact = (23800 * (127 + 900) * days1) / (10000 * 365) + (23800 * (188 + 900) * days2) / (10000 * 365);
    expect(seg.interestCents).toBe(roundHalfUp(exact));
  });

  it("Satzwechsel exakt am Faelligkeitstag (from) erzeugt keinen leeren Abschnitt — sofort der neue Satz gilt", () => {
    const cut = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-08-01T00:00:00.000Z");
    const rates: BaseRateEntry[] = [
      { validFrom: new Date("2026-01-01T00:00:00.000Z"), rateBp: 127 },
      { validFrom: cut, rateBp: 188 },
    ];
    const seg = computeInterestSegments({ openAmountCents: 10000, from: cut, to, isConsumer: true, rates });
    expect(seg.segments).toHaveLength(1);
    expect(seg.segments[0]!.baseRateBp).toBe(188);
  });

  it("drei Abschnitte ueber zwei Jahreswechsel", () => {
    const from = new Date("2025-12-01T00:00:00.000Z");
    const to = new Date("2027-01-15T00:00:00.000Z");
    const rates: BaseRateEntry[] = [
      { validFrom: new Date("2025-07-01T00:00:00.000Z"), rateBp: 337 },
      { validFrom: new Date("2026-01-01T00:00:00.000Z"), rateBp: 127 },
      { validFrom: new Date("2027-01-01T00:00:00.000Z"), rateBp: 188 },
    ];
    const seg = computeInterestSegments({ openAmountCents: 50000, from, to, isConsumer: false, rates });
    expect(seg.segments.map((s) => s.baseRateBp)).toEqual([337, 127, 188]);
    const totalDays = seg.segments.reduce((sum, s) => sum + s.days, 0);
    expect(totalDays).toBe(daysBetween(from, to));
  });

  it("daysOverdue = 0 (from === to) ergibt keine Abschnitte und 0 Cent", () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    const rates: BaseRateEntry[] = [{ validFrom: new Date("2026-01-01T00:00:00.000Z"), rateBp: 127 }];
    const seg = computeInterestSegments({ openAmountCents: 100000, from: at, to: at, isConsumer: false, rates });
    expect(seg.segments).toHaveLength(0);
    expect(seg.interestCents).toBe(0);
  });

  it("baseRateBpWeighted ist der tagegewichtete Mittelwert der Abschnitte", () => {
    const from = new Date("2026-06-21T00:00:00.000Z"); // 10 Tage vor dem Wechsel
    const to = new Date("2026-07-11T00:00:00.000Z"); // 10 Tage nach dem Wechsel
    const rates: BaseRateEntry[] = [
      { validFrom: new Date("2026-01-01T00:00:00.000Z"), rateBp: 100 },
      { validFrom: new Date("2026-07-01T00:00:00.000Z"), rateBp: 200 },
    ];
    const seg = computeInterestSegments({ openAmountCents: 100000, from, to, isConsumer: false, rates });
    expect(seg.segments.map((s) => s.days)).toEqual([10, 10]);
    expect(seg.baseRateBpWeighted).toBe(150); // (100*10 + 200*10) / 20, exakt
  });
});
