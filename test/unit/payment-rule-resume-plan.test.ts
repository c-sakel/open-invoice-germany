/** Fortsetzen pausierter Abos ohne Nachholen versaeumter Perioden (reine Planung). */
import { describe, expect, it } from "vitest";
import { planSkipMissed, type SkipMissedInput } from "@/domain/payment-rule/resume-plan";

const noon = (y: number, m: number, d: number): Date => new Date(y, m - 1, d, 12, 0, 0, 0);
const base: SkipMissedInput = {
  nextRunDate: noon(2211, 1, 15),
  interval: "MONTHLY",
  intervalCount: 1,
  anchorDay: 15,
  endDate: null,
  now: new Date("2211-04-10T10:00:00.000Z"),
  oldestOpenUsagePeriodEnd: null,
};

describe("planSkipMissed", () => {
  it("Stichtag heute oder spaeter -> unveraendert", () => {
    expect(planSkipMissed({ ...base, nextRunDate: noon(2211, 4, 10) })).toEqual({ kind: "UNCHANGED" });
    expect(planSkipMissed({ ...base, nextRunDate: noon(2211, 5, 1) })).toEqual({ kind: "UNCHANGED" });
  });

  it("drei Monate Pause -> auf den naechsten Stichtag vorruecken, drei uebersprungen", () => {
    const plan = planSkipMissed(base);
    expect(plan.kind).toBe("ADVANCE");
    if (plan.kind === "ADVANCE") {
      expect(plan.skipped).toBe(3);
      expect(plan.nextRunDate.getTime()).toBe(noon(2211, 4, 15).getTime());
    }
  });

  it("Ankertag 31 im Februar wird an den Monatsletzten geklemmt", () => {
    const plan = planSkipMissed({ ...base, nextRunDate: noon(2211, 1, 31), anchorDay: 31, now: new Date("2211-02-20T10:00:00.000Z") });
    expect(plan.kind).toBe("ADVANCE");
    if (plan.kind === "ADVANCE") expect(plan.nextRunDate.getTime()).toBe(noon(2211, 2, 28).getTime());
  });

  it("Enddatum im uebersprungenen Bereich -> beendet", () => {
    expect(planSkipMissed({ ...base, endDate: noon(2211, 3, 1) }).kind).toBe("ENDS");
  });

  it("offener Verbrauch in uebersprungenen Perioden -> Rueckstand abrechnen", () => {
    expect(planSkipMissed({ ...base, oldestOpenUsagePeriodEnd: noon(2211, 2, 15) }).kind).toBe("BILL_FALLBACK");
    expect(planSkipMissed({ ...base, oldestOpenUsagePeriodEnd: noon(2211, 4, 15) }).kind).toBe("ADVANCE");
  });

  it("Berliner Tagesgrenze: 23:30 UTC ist schon der Folgetag", () => {
    const input = { ...base, nextRunDate: noon(2211, 4, 10), now: new Date("2211-04-09T23:30:00.000Z") };
    expect(planSkipMissed(input).kind).toBe("UNCHANGED");
    expect(planSkipMissed({ ...input, nextRunDate: noon(2211, 4, 9) }).kind).toBe("ADVANCE");
  });
});
