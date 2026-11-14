import { describe, it, expect } from "vitest";
import { resolveUsagePeriod, MAX_USAGE_PERIOD_STEPS } from "@/domain/recurring/usage-period";
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
