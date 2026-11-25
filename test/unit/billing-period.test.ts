import { describe, it, expect } from "vitest";
import {
  addDays,
  billingPeriod,
  firstStichtag,
  nextStichtag,
  normalizeToNoon,
  previewPeriods,
  validateLeistungsbeginn,
  type BillingTiming,
  type RecurInterval,
} from "@/lib/recurring";

const d = (s: string) => new Date(`${s}T12:00:00`);
const iso = (x: Date) =>
  `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const span = (p: { start: Date; end: Date }) => `${iso(p.start)}..${iso(p.end)}`;

describe("billingPeriod / nextStichtag", () => {
  it("1. ADVANCE jaehrlich, Anker 25", () => {
    const p = billingPeriod("ADVANCE", d("2026-11-25"), "YEARLY", 1, 25);
    expect(span(p)).toBe("2026-11-25..2027-11-24");
    expect(p.clippedByEndDate).toBe(false);
    expect(iso(nextStichtag(d("2026-11-25"), "YEARLY", 1, 25))).toBe("2027-11-25");
  });

  it("2. ARREARS jaehrlich Bestand (Anker null): kein doppelter Tag", () => {
    expect(span(billingPeriod("ARREARS", d("2027-11-25"), "YEARLY", 1, null))).toBe("2026-11-26..2027-11-25");
  });

  it("3. ADVANCE monatlich ab 31.01. ohne Drift", () => {
    let s = d("2026-01-31");
    const out: string[] = [];
    const stichtage: string[] = [];
    for (let i = 0; i < 3; i++) {
      out.push(span(billingPeriod("ADVANCE", s, "MONTHLY", 1, 31)));
      stichtage.push(iso(s));
      s = nextStichtag(s, "MONTHLY", 1, 31);
    }
    expect(out).toEqual(["2026-01-31..2026-02-27", "2026-02-28..2026-03-30", "2026-03-31..2026-04-29"]);
    expect(stichtage).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("4. ARREARS neu, Leistungsbeginn 01.01. monatlich", () => {
    const f = firstStichtag("ARREARS", d("2026-01-01"), "MONTHLY", 1);
    expect(iso(f.stichtag)).toBe("2026-01-31");
    expect(f.anchorDay).toBe(31);
    let s = f.stichtag;
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      out.push(span(billingPeriod("ARREARS", s, "MONTHLY", 1, f.anchorDay)));
      s = nextStichtag(s, "MONTHLY", 1, f.anchorDay);
    }
    expect(out).toEqual(["2026-01-01..2026-01-31", "2026-02-01..2026-02-28", "2026-03-01..2026-03-31"]);
  });

  it("5. ARREARS neu, Leistungsbeginn 15.01. monatlich", () => {
    const f = firstStichtag("ARREARS", d("2026-01-15"), "MONTHLY", 1);
    expect(iso(f.stichtag)).toBe("2026-02-14");
    expect(f.anchorDay).toBe(14);
    const n = nextStichtag(f.stichtag, "MONTHLY", 1, f.anchorDay);
    expect(span(billingPeriod("ARREARS", f.stichtag, "MONTHLY", 1, f.anchorDay))).toBe("2026-01-15..2026-02-14");
    expect(span(billingPeriod("ARREARS", n, "MONTHLY", 1, f.anchorDay))).toBe("2026-02-15..2026-03-14");
  });

  it("6. ARREARS neu, Leistungsbeginn 01.12.2026 vierteljaehrlich", () => {
    const f = firstStichtag("ARREARS", d("2026-12-01"), "QUARTERLY", 1);
    expect(iso(f.stichtag)).toBe("2027-02-28");
    expect(f.anchorDay).toBe(31);
    const n = nextStichtag(f.stichtag, "QUARTERLY", 1, f.anchorDay);
    expect(span(billingPeriod("ARREARS", n, "QUARTERLY", 1, f.anchorDay))).toBe("2027-03-01..2027-05-31");
  });

  it("ADVANCE: firstStichtag = Leistungsbeginn, Anker = Tag; DAY/WEEKLY ohne Anker", () => {
    const f = firstStichtag("ADVANCE", d("2026-01-31"), "MONTHLY", 1);
    expect(iso(f.stichtag)).toBe("2026-01-31");
    expect(f.anchorDay).toBe(31);
    expect(firstStichtag("ADVANCE", d("2026-01-31"), "WEEKLY", 1).anchorDay).toBeNull();
    const w = firstStichtag("ARREARS", d("2026-01-05"), "WEEKLY", 1);
    expect(w.anchorDay).toBeNull();
    expect(iso(w.stichtag)).toBe("2026-01-11");
  });
});

describe("validateLeistungsbeginn", () => {
  it("7. ARREARS 30.01. monatlich -> Meldung; ADVANCE -> null; WEEKLY -> null", () => {
    expect(validateLeistungsbeginn("ARREARS", d("2026-01-30"), "MONTHLY")).toMatch(/1\.–28\./);
    expect(validateLeistungsbeginn("ADVANCE", d("2026-01-30"), "MONTHLY")).toBeNull();
    expect(validateLeistungsbeginn("ARREARS", d("2026-01-30"), "WEEKLY")).toBeNull();
    expect(validateLeistungsbeginn("ARREARS", d("2026-01-28"), "MONTHLY")).toBeNull();
    expect(validateLeistungsbeginn("ARREARS", d("2026-01-31"), "DAY")).toBeNull();
  });
});

describe("Schaltjahr", () => {
  it("8. ADVANCE jaehrlich ab 29.02.2028 lueckenlos", () => {
    let s = d("2028-02-29");
    const out: string[] = [];
    for (let i = 0; i < 4; i++) {
      out.push(span(billingPeriod("ADVANCE", s, "YEARLY", 1, 29)));
      s = nextStichtag(s, "YEARLY", 1, 29);
    }
    expect(out).toEqual([
      "2028-02-29..2029-02-27",
      "2029-02-28..2030-02-27",
      "2030-02-28..2031-02-27",
      "2031-02-28..2032-02-28",
    ]);
    expect(iso(s)).toBe("2032-02-29");
  });
});

describe("Eigenschaftstest lueckenlos", () => {
  const cases: [RecurInterval, number][] = [
    ["DAY", 1], ["DAY", 2], ["DAY", 3], ["WEEKLY", 1], ["WEEKLY", 2],
    ["MONTHLY", 1], ["MONTHLY", 2], ["QUARTERLY", 1], ["YEARLY", 1],
  ];
  const timings: BillingTiming[] = ["ADVANCE", "ARREARS"];
  for (const [interval, count] of cases) {
    for (const timing of timings) {
      it(`${timing} ${interval} x${count}`, () => {
        for (const day of [1, 15, 28, 29, 30, 31]) {
          const start = new Date(2027, 0, day, 12);
          if (validateLeistungsbeginn(timing, start, interval) !== null) continue;
          const f = firstStichtag(timing, start, interval, count);
          let s = f.stichtag;
          let prevEnd: Date | null = null;
          for (let i = 0; i < 36; i++) {
            const p = billingPeriod(timing, s, interval, count, f.anchorDay);
            expect(p.end.getTime()).toBeGreaterThanOrEqual(p.start.getTime());
            if (i === 0) expect(iso(p.start)).toBe(iso(start));
            if (prevEnd) expect(iso(addDays(prevEnd, 1))).toBe(iso(p.start));
            prevEnd = p.end;
            s = nextStichtag(s, interval, count, f.anchorDay);
          }
        }
      });
    }
  }
});

describe("endDate / previewPeriods", () => {
  const base = {
    billingTiming: "ADVANCE" as BillingTiming,
    nextRunDate: d("2026-01-01"),
    interval: "MONTHLY" as RecurInterval,
    intervalCount: 1,
    anchorDay: 1,
    endDate: null as Date | null,
    status: "ACTIVE",
    maxRuns: null as number | null,
    issuedCount: 0,
  };

  it("10a. endDate innerhalb der Periode kuerzt end (ADVANCE)", () => {
    const p = billingPeriod("ADVANCE", d("2026-03-01"), "MONTHLY", 1, 1, d("2026-03-15"));
    expect(span(p)).toBe("2026-03-01..2026-03-15");
    expect(p.clippedByEndDate).toBe(true);
    expect(billingPeriod("ADVANCE", d("2026-03-01"), "MONTHLY", 1, 1, d("2026-03-31")).clippedByEndDate).toBe(false);
  });

  it("10b. kein Lauf nach endDate; Vorschau markiert gekuerzte Periode", () => {
    const r = previewPeriods({ ...base, endDate: d("2026-03-15") });
    expect(r.map((x) => iso(x.runDate))).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(r[2].clippedByEndDate).toBe(true);
    expect(iso(r[2].end)).toBe("2026-03-15");
  });

  it("10c. maxRuns - issuedCount begrenzt; PAUSED/ENDED leer; n begrenzt", () => {
    expect(previewPeriods({ ...base, maxRuns: 5, issuedCount: 3 })).toHaveLength(2);
    expect(previewPeriods({ ...base, status: "PAUSED" })).toEqual([]);
    expect(previewPeriods({ ...base, status: "ENDED" })).toEqual([]);
    expect(previewPeriods(base)).toHaveLength(6);
    expect(previewPeriods(base, 3)).toHaveLength(3);
  });

  it("ARREARS: letzter Stichtag <= endDate", () => {
    const r = previewPeriods({ ...base, billingTiming: "ARREARS", nextRunDate: d("2026-01-31"), anchorDay: 31, endDate: d("2026-03-30") });
    expect(r.map((x) => iso(x.runDate))).toEqual(["2026-01-31", "2026-02-28"]);
    expect(r.every((x) => !x.clippedByEndDate)).toBe(true);
  });
});

describe("normalizeToNoon (A9)", () => {
  it("11. Berliner Kalendertag statt Serverzeit", () => {
    const n = normalizeToNoon(new Date("2026-11-25T00:00:00+01:00"));
    expect(iso(n)).toBe("2026-11-25");
    expect(n.getHours()).toBe(12);
  });
});
