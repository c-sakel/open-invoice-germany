import { describe, it, expect } from "vitest";
import {
  berlinDateKey,
  berlinDayEnd,
  berlinMidnight,
  berlinMonthKey,
  berlinMonthStart,
  berlinParts,
  berlinYear,
  berlinYearStart,
} from "@/lib/berlin-time";

const iso = (d: Date) => d.toISOString();

describe("berlin-time", () => {
  it("berlinMonthKey an Monats- und Jahresgrenzen", () => {
    expect(berlinMonthKey(new Date("2150-03-31T22:30:00Z"))).toBe("2150-04");
    expect(berlinMonthKey(new Date("2150-03-31T21:30:00Z"))).toBe("2150-03");
    expect(berlinMonthKey(new Date("2150-12-31T23:30:00Z"))).toBe("2151-01");
  });

  it("berlinMonthStart mit Offsets ueber Jahresgrenze", () => {
    const d = new Date("2150-04-15T10:00:00Z");
    expect(iso(berlinMonthStart(d))).toBe("2150-03-31T22:00:00.000Z");
    expect(iso(berlinMonthStart(d, -1))).toBe("2150-02-28T23:00:00.000Z");
    expect(iso(berlinMonthStart(d, 1))).toBe("2150-04-30T22:00:00.000Z");
    // April 2150 - 13 Monate = März 2149 (MEZ, vor der Umstellung am 29.03.)
    expect(iso(berlinMonthStart(d, -13))).toBe("2149-02-28T23:00:00.000Z");
    expect(berlinMonthKey(berlinMonthStart(d, -13))).toBe("2149-03");
    expect(iso(berlinMonthStart(new Date("2150-12-15T10:00:00Z"), 1))).toBe("2150-12-31T23:00:00.000Z");
  });

  it("berlinDayEnd inkl. Umstellungstage", () => {
    expect(iso(berlinDayEnd(new Date("2150-03-31T00:00:00Z")))).toBe("2150-03-31T21:59:59.999Z");
    expect(iso(berlinDayEnd(new Date("2150-12-31T00:00:00Z")))).toBe("2150-12-31T22:59:59.999Z");
    expect(iso(berlinDayEnd(new Date("2150-03-29T00:00:00Z")))).toBe("2150-03-29T21:59:59.999Z");
    expect(iso(berlinDayEnd(new Date("2150-10-25T00:00:00Z")))).toBe("2150-10-25T22:59:59.999Z");
  });

  it("berlinYear, berlinYearStart, berlinDateKey", () => {
    expect(berlinYear(new Date("2150-12-31T23:30:00Z"))).toBe(2151);
    expect(berlinYear(new Date("2150-12-31T22:30:00Z"))).toBe(2150);
    expect(iso(berlinYearStart(2151))).toBe("2150-12-31T23:00:00.000Z");
    expect(berlinDateKey(new Date("2150-03-31T22:30:00Z"))).toBe("2150-04-01");
  });

  it("berlinMidnight normalisiert Ueberlauf", () => {
    expect(iso(berlinMidnight(2150, 13, 1))).toBe(iso(berlinMidnight(2151, 1, 1)));
    expect(iso(berlinMidnight(2150, 3, 0))).toBe(iso(berlinMidnight(2150, 2, 28)));
  });

  it("jede UTC-Mitternacht liegt im selben Berliner Kalendertag", () => {
    for (let i = 0; i < 365; i++) {
      const d = new Date(Date.UTC(2150, 0, 1 + i));
      const p = berlinParts(d);
      expect([p.year, p.month, p.day]).toEqual([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]);
    }
  });
});
