import { describe, it, expect } from "vitest";
import { billingPeriod, previewPeriods, unbilledRest, type PreviewInput } from "@/lib/recurring";
import { resolveFirstSchedule } from "@/domain/recurring/timing";
import { RecurringError } from "@/domain/recurring/errors";

const noon = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};
const key = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("Bestandsabo ohne Ankertag: keine Doppelabrechnung nach dem Klemmen (31.01. -> 28.02.)", () => {
  it("ohne letztes Ende überlappt der Zeitraum (altes Verhalten, Ausgangspunkt)", () => {
    const p = billingPeriod("ARREARS", noon("2027-02-28"), "MONTHLY", 1, null);
    expect(key(p.start)).toBe("2027-01-29");
  });

  it("mit Ende der letzten Rechnung beginnt der Zeitraum am Folgetag", () => {
    const p = billingPeriod("ARREARS", noon("2027-02-28"), "MONTHLY", 1, null, null, noon("2027-01-31"));
    expect(`${key(p.start)}..${key(p.end)}`).toBe("2027-02-01..2027-02-28");
  });

  it("schließt nie eine Lücke und wirkt nicht bei Ankertag oder im Voraus", () => {
    expect(key(billingPeriod("ARREARS", noon("2027-02-28"), "MONTHLY", 1, null, null, noon("2027-01-10")).start)).toBe("2027-01-29");
    expect(key(billingPeriod("ARREARS", noon("2027-02-28"), "MONTHLY", 1, 31, null, noon("2027-01-31")).start)).toBe("2027-02-01");
    expect(key(billingPeriod("ADVANCE", noon("2027-02-28"), "MONTHLY", 1, null, null, noon("2027-03-05")).start)).toBe("2027-02-28");
  });

  it("Vorschau führt das Ende von Zeitraum zu Zeitraum weiter", () => {
    const input: PreviewInput = {
      billingTiming: "ARREARS", nextRunDate: noon("2027-02-28"), interval: "MONTHLY", intervalCount: 1, anchorDay: null,
      endDate: null, status: "ACTIVE", maxRuns: null, issuedCount: 1, previousEnd: noon("2027-01-31"),
    };
    const out = previewPeriods(input, 2).map((p) => `${key(p.start)}..${key(p.end)}`);
    expect(out).toEqual(["2027-02-01..2027-02-28", "2027-03-01..2027-03-28"]);
  });
});

describe("unbilledRest (Rest nach dem letzten Stichtag bei nachträglicher Abrechnung)", () => {
  const base: PreviewInput = {
    billingTiming: "ARREARS", nextRunDate: noon("2027-01-31"), interval: "MONTHLY", intervalCount: 1, anchorDay: 31,
    endDate: noon("2027-03-15"), status: "ACTIVE", maxRuns: null, issuedCount: 0,
  };

  it("liefert den Zeitraum nach dem letzten Stichtag bis zum Vertragsende", () => {
    const r = unbilledRest(base);
    expect(r && `${key(r.start)}..${key(r.end)}`).toBe("2027-03-01..2027-03-15");
  });

  it("kein Rest bei Vertragsende am Stichtag, ohne Vertragsende, im Voraus oder pausiert", () => {
    expect(unbilledRest({ ...base, endDate: noon("2027-03-31") })).toBeNull();
    expect(unbilledRest({ ...base, endDate: null })).toBeNull();
    expect(unbilledRest({ ...base, billingTiming: "ADVANCE" })).toBeNull();
    expect(unbilledRest({ ...base, status: "PAUSED" })).toBeNull();
  });

  it("maxRuns begrenzt den letzten Stichtag", () => {
    const r = unbilledRest({ ...base, maxRuns: 1 });
    expect(r && `${key(r.start)}..${key(r.end)}`).toBe("2027-02-01..2027-03-15");
  });
});

describe("Ankertag bei täglichem/wöchentlichem Rhythmus", () => {
  it("wird ignoriert statt abgelehnt; bei Monatsrhythmus weiter geprüft", () => {
    expect(resolveFirstSchedule("ADVANCE", noon("2027-01-05"), "WEEKLY", 1, 17).anchorDay).toBeNull();
    expect(resolveFirstSchedule("ADVANCE", noon("2027-01-05"), "DAY", 1, 3).anchorDay).toBeNull();
    expect(() => resolveFirstSchedule("ADVANCE", noon("2027-01-05"), "MONTHLY", 1, 17)).toThrow(RecurringError);
  });
});
