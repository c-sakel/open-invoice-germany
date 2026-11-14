import { describe, it, expect } from "vitest";
import { resolveUsagePeriod, effectiveAnchorDay, MAX_USAGE_PERIOD_STEPS } from "@/domain/recurring/usage-period";
import { advanceDate, periodRange } from "@/lib/recurring";
import { UsageError } from "@/domain/recurring/usage-error";

const noon = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12, 0, 0, 0);
};
const key = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const monthly = { nextRunDate: noon("2187-03-31"), interval: "MONTHLY", intervalCount: 1, anchorDay: null, endDate: null };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof UsageError ? e.code : "OTHER";
  }
  return undefined;
}

describe("resolveUsagePeriod", () => {
  it("Tag in der ersten offenen Periode", () => {
    const p = resolveUsagePeriod(monthly, noon("2187-03-15"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2187-02-28", "2187-03-31"]);
  });
  it("Stichtag gehoert zur endenden Periode", () => {
    const p = resolveUsagePeriod(monthly, noon("2187-03-31"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2187-02-28", "2187-03-31"]);
  });
  it("Tag nach dem Stichtag -> naechste Periode", () => {
    const p = resolveUsagePeriod(monthly, noon("2187-04-01"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2187-03-31", "2187-04-30"]);
  });
  it("Tag am Beginn der ersten Periode ist bereits abgerechnet", () => {
    expect(code(() => resolveUsagePeriod(monthly, noon("2187-02-28")))).toBe("PERIOD_BILLED");
    expect(code(() => resolveUsagePeriod(monthly, noon("2187-01-10")))).toBe("PERIOD_BILLED");
  });
  it("Periode nach dem Enddatum -> AFTER_END", () => {
    const rec = { ...monthly, endDate: noon("2187-04-15") };
    expect(code(() => resolveUsagePeriod(rec, noon("2187-04-20")))).toBe("AFTER_END");
    // Stichtag 30.04. liegt nach dem Enddatum: der Lauf wuerde nicht mehr stattfinden.
    expect(code(() => resolveUsagePeriod(rec, noon("2187-04-10")))).toBe("AFTER_END");
    expect(key(resolveUsagePeriod({ ...monthly, endDate: noon("2187-04-30") }, noon("2187-04-10")).periodEnd)).toBe("2187-04-30");
  });
  it("WEEKLY", () => {
    const rec = { nextRunDate: noon("2187-03-10"), interval: "WEEKLY", intervalCount: 1, anchorDay: null, endDate: null };
    const p = resolveUsagePeriod(rec, noon("2187-03-08"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2187-03-03", "2187-03-10"]);
    const q = resolveUsagePeriod(rec, noon("2187-03-11"));
    expect([key(q.periodStart), key(q.periodEnd)]).toEqual(["2187-03-10", "2187-03-17"]);
  });
  it("DAY mit intervalCount 2", () => {
    const rec = { nextRunDate: noon("2187-03-10"), interval: "DAY", intervalCount: 2, anchorDay: null, endDate: null };
    const p = resolveUsagePeriod(rec, noon("2187-03-11"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2187-03-10", "2187-03-12"]);
  });
  it("mehr als 400 Perioden voraus -> Fehler", () => {
    const rec = { nextRunDate: noon("2187-03-10"), interval: "DAY", intervalCount: 1, anchorDay: null, endDate: null };
    expect(code(() => resolveUsagePeriod(rec, noon("2189-06-01")))).toBe("IN_FUTURE");
    expect(MAX_USAGE_PERIOD_STEPS).toBe(400);
  });
});

describe("effectiveAnchorDay / Monatsende", () => {
  it("Anker aus dem Startdatum nur fuer Verbrauchsabos ohne anchorDay", () => {
    const startDate = noon("2187-01-31");
    expect(effectiveAnchorDay({ anchorDay: null, startDate }, true)).toBe(31);
    expect(effectiveAnchorDay({ anchorDay: null, startDate }, false)).toBeNull();
    expect(effectiveAnchorDay({ anchorDay: 15, startDate }, true)).toBe(15);
  });
  it("Stichtag 30.04., Anker 31: Verbrauch am 31.03. ist abgerechnet, 01.04. gehoert in (31.03., 30.04.]", () => {
    const rec = { nextRunDate: noon("2187-04-30"), interval: "MONTHLY", intervalCount: 1, anchorDay: 31, endDate: null };
    expect(code(() => resolveUsagePeriod(rec, noon("2187-03-31")))).toBe("PERIOD_BILLED");
    const p = resolveUsagePeriod(rec, noon("2187-04-01"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2187-03-31", "2187-04-30"]);
  });
  it("Februar und Schaltjahr", () => {
    const feb = { nextRunDate: noon("2187-02-28"), interval: "MONTHLY", intervalCount: 1, anchorDay: 31, endDate: null };
    expect(key(resolveUsagePeriod(feb, noon("2187-02-10")).periodStart)).toBe("2187-01-31");
    expect(code(() => resolveUsagePeriod(feb, noon("2187-01-31")))).toBe("PERIOD_BILLED");
    const leap = { nextRunDate: noon("2188-02-29"), interval: "MONTHLY", intervalCount: 1, anchorDay: 31, endDate: null };
    const p = resolveUsagePeriod(leap, noon("2188-03-01"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2188-02-29", "2188-03-31"]);
  });
  it("Start 31.03. (Quartal): Perioden 31.03./30.06./30.09.", () => {
    const rec = { nextRunDate: noon("2187-06-30"), interval: "QUARTERLY", intervalCount: 1, anchorDay: 31, endDate: null };
    const p = resolveUsagePeriod(rec, noon("2187-07-01"));
    expect([key(p.periodStart), key(p.periodEnd)]).toEqual(["2187-06-30", "2187-09-30"]);
    expect(code(() => resolveUsagePeriod(rec, noon("2187-03-31")))).toBe("PERIOD_BILLED");
  });
});

describe("Periodenanker ueber mehrere Laeufe (Start am Monatsende)", () => {
  const cases: { start: string; stichtage: string[] }[] = [
    { start: "2187-01-31", stichtage: ["2187-01-31", "2187-02-28", "2187-03-31", "2187-04-30", "2187-05-31"] },
    { start: "2187-01-30", stichtage: ["2187-01-30", "2187-02-28", "2187-03-30", "2187-04-30", "2187-05-30"] },
    { start: "2187-01-29", stichtage: ["2187-01-29", "2187-02-28", "2187-03-29", "2187-04-29", "2187-05-29"] },
    { start: "2188-01-31", stichtage: ["2188-01-31", "2188-02-29", "2188-03-31", "2188-04-30", "2188-05-31"] },
    { start: "2188-01-30", stichtage: ["2188-01-30", "2188-02-29", "2188-03-30", "2188-04-30", "2188-05-30"] },
    { start: "2188-01-29", stichtage: ["2188-01-29", "2188-02-29", "2188-03-29", "2188-04-29", "2188-05-29"] },
  ];
  for (const c of cases) {
    it(`Start ${c.start}: Stichtage ${c.stichtage.slice(1, 4).join(" -> ")}, Perioden luecken- und ueberlappungsfrei, BG-14/BG-26 = Periodengrenzen`, () => {
      const startDate = noon(c.start);
      const anchor = effectiveAnchorDay({ anchorDay: null, startDate }, true);
      expect(anchor).toBe(startDate.getDate());
      // Lauf: nextRunDate wird je Lauf vom Stichtag aus fortgeschrieben (wie run.ts).
      const days: Date[] = [startDate];
      for (let i = 1; i < c.stichtage.length; i++) days.push(advanceDate(days[i - 1]!, "MONTHLY", 1, anchor));
      expect(days.map(key)).toEqual(c.stichtage);
      let prevEnd: Date | null = null;
      for (const stichtag of days) {
        const { start, end } = periodRange(stichtag, "MONTHLY", 1, anchor);
        expect(key(end)).toBe(key(stichtag));
        // BG-14 = Periodenbeginn, BG-26 = Periodenende je Position: lueckenlos an die Vorperiode (Beginn = Vor-Stichtag)
        if (prevEnd) expect(key(start)).toBe(key(prevEnd));
        expect(start.getTime()).toBeLessThan(end.getTime());
        prevEnd = end;
      }
      // Verbrauchstage um jeden Stichtag fallen in genau eine Periode; der Stichtag gehoert zur endenden.
      for (let i = 1; i < days.length; i++) {
        const rec = { nextRunDate: days[i]!, interval: "MONTHLY", intervalCount: 1, anchorDay: anchor, endDate: null };
        const inside = resolveUsagePeriod(rec, days[i]!);
        expect([key(inside.periodStart), key(inside.periodEnd)]).toEqual([key(days[i - 1]!), key(days[i]!)]);
        const next = resolveUsagePeriod(rec, advanceDate(days[i]!, "DAY", 1));
        expect(key(next.periodStart)).toBe(key(days[i]!));
        expect(key(next.periodEnd)).toBe(key(advanceDate(days[i]!, "MONTHLY", 1, anchor)));
      }
    });
  }
  it("FIXED-Abo ohne Anker (Regression): bisheriges Abdriften bleibt unveraendert", () => {
    expect(effectiveAnchorDay({ anchorDay: null, startDate: noon("2187-01-31") }, false)).toBeNull();
    const feb = advanceDate(noon("2187-01-31"), "MONTHLY", 1, null);
    expect(key(feb)).toBe("2187-02-28");
    expect(key(advanceDate(feb, "MONTHLY", 1, null))).toBe("2187-03-28");
  });
});
