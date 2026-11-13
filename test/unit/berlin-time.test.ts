import { describe, it, expect } from "vitest";
import {
  berlinCalendarDay,
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

  it("Umstellungssonntage 2151: 23-h-Tag im Maerz, 25-h-Tag im Oktober", () => {
    // Letzter Sonntag im Maerz 2151 = 28.03. (02:00 MEZ -> 03:00 MESZ)
    expect(berlinMidnight(2151, 3, 28).toISOString()).toBe("2151-03-27T23:00:00.000Z");
    expect(berlinMidnight(2151, 3, 29).toISOString()).toBe("2151-03-28T22:00:00.000Z");
    const springEnd = berlinDayEnd(new Date("2151-03-28T00:00:00Z"));
    expect(springEnd.toISOString()).toBe("2151-03-28T21:59:59.999Z");
    expect(springEnd.getTime() + 1 - berlinMidnight(2151, 3, 28).getTime()).toBe(23 * 3_600_000);
    // Letzter Sonntag im Oktober 2151 = 31.10. (03:00 MESZ -> 02:00 MEZ)
    expect(berlinMidnight(2151, 10, 31).toISOString()).toBe("2151-10-30T22:00:00.000Z");
    expect(berlinMidnight(2151, 11, 1).toISOString()).toBe("2151-10-31T23:00:00.000Z");
    const autumnEnd = berlinDayEnd(new Date("2151-10-31T00:00:00Z"));
    expect(autumnEnd.toISOString()).toBe("2151-10-31T22:59:59.999Z");
    expect(autumnEnd.getTime() + 1 - berlinMidnight(2151, 10, 31).getTime()).toBe(25 * 3_600_000);
    // Monatsgrenze ueber die Fruehjahrsumstellung
    expect(berlinMonthStart(new Date("2151-04-15T12:00:00Z"), -1).toISOString()).toBe("2151-02-28T23:00:00.000Z");
    expect(berlinMonthStart(new Date("2151-03-15T12:00:00Z"), 1).toISOString()).toBe("2151-03-31T22:00:00.000Z");
  });
});

describe("berlinCalendarDay", () => {
  it("liefert UTC-Mitternacht des Berliner Kalendertags (Winter und Sommer)", () => {
    expect(iso(berlinCalendarDay(new Date("2160-01-14T23:30:00Z")))).toBe("2160-01-15T00:00:00.000Z");
    expect(iso(berlinCalendarDay(new Date("2160-07-14T22:30:00Z")))).toBe("2160-07-15T00:00:00.000Z");
    expect(iso(berlinCalendarDay(new Date("2160-07-14T21:59:59.999Z")))).toBe("2160-07-14T00:00:00.000Z");
  });

  it("laesst UTC-Mitternachtswerte unveraendert und ist idempotent", () => {
    const m = new Date("2160-01-15T00:00:00Z");
    expect(iso(berlinCalendarDay(m))).toBe("2160-01-15T00:00:00.000Z");
    const x = new Date("2160-03-10T23:30:00Z");
    expect(iso(berlinCalendarDay(berlinCalendarDay(x)))).toBe(iso(berlinCalendarDay(x)));
  });

  it("Umstellungssonntage 2160: 00:30 und 23:30 Berliner Zeit liegen im selben Tag", () => {
    for (const month of [3, 10]) {
      let d = new Date(Date.UTC(2160, month, 0)); // letzter Tag des Monats
      while (d.getUTCDay() !== 0) d = new Date(d.getTime() - 86_400_000);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const start = berlinMidnight(y, m, day).getTime() + 30 * 60_000;
      const end = berlinMidnight(y, m, day + 1).getTime() - 30 * 60_000;
      const expected = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`;
      expect(iso(berlinCalendarDay(new Date(start)))).toBe(expected);
      expect(iso(berlinCalendarDay(new Date(end)))).toBe(expected);
    }
  });
});
