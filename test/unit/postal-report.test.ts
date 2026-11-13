import { describe, expect, it } from "vitest";
import { aggregatePostalMonths } from "@/domain/postal/report";
import { cancelWindow } from "@/domain/postal/ui";

const row = (over: Partial<Parameters<typeof aggregatePostalMonths>[0][number]>) => ({
  mode: "LIVE",
  status: "QUEUED",
  priceCents: null as number | null,
  quotedPriceCents: 68 as number | null,
  createdAt: new Date("2129-04-10T10:00:00Z"),
  ...over,
});

describe("aggregatePostalMonths", () => {
  it("Monatsgrenze: 31.03. 23:30 UTC (= 01.04. Berlin) faellt in April", () => {
    const res = aggregatePostalMonths([row({ createdAt: new Date("2129-03-31T23:30:00Z") }), row({ createdAt: new Date("2129-03-31T21:30:00Z") })]);
    expect(res.map((m) => [m.month, m.liveCount])).toEqual([
      ["2129-04", 1],
      ["2129-03", 1],
    ]);
  });

  it("Summe nur LIVE ohne FAILED/CANCELLED; tatsaechlicher Preis vor Angebotspreis; TEST und Trockenlauf getrennt gezaehlt", () => {
    const res = aggregatePostalMonths([
      row({ priceCents: 70 }),
      row({}),
      row({ status: "FAILED" }),
      row({ status: "CANCELLED" }),
      row({ mode: "DRY_RUN", status: "DRY_RUN" }),
      row({ mode: "TEST" }),
      row({ mode: "TEST", status: "CANCELLED" }),
    ]);
    expect(res).toEqual([{ month: "2129-04", liveCount: 2, liveCents: 138, testCount: 1, dryRunCount: 1 }]);
  });

  it("leer -> leer; juengster Monat zuerst", () => {
    expect(aggregatePostalMonths([])).toEqual([]);
    const res = aggregatePostalMonths([row({ createdAt: new Date("2129-01-05T10:00:00Z") }), row({ createdAt: new Date("2129-06-05T10:00:00Z") })]);
    expect(res.map((m) => m.month)).toEqual(["2129-06", "2129-01"]);
  });
});

describe("cancelWindow", () => {
  const now = new Date("2129-06-09T10:10:00Z");
  it("stornierbar nur QUEUED/HOLD/DRAFT binnen 15 Minuten, mit Restzeit", () => {
    expect(cancelWindow({ mode: "LIVE", status: "QUEUED", submittedAt: new Date("2129-06-09T10:00:00Z") }, now)).toEqual({ cancellable: true, remainingMs: 5 * 60_000 });
    expect(cancelWindow({ mode: "LIVE", status: "QUEUED", submittedAt: new Date("2129-06-09T09:50:00Z") }, now)).toEqual({ cancellable: false, remainingMs: null });
    expect(cancelWindow({ mode: "LIVE", status: "DONE", submittedAt: new Date("2129-06-09T10:00:00Z") }, now).cancellable).toBe(false);
    expect(cancelWindow({ mode: "DRY_RUN", status: "DRY_RUN", submittedAt: null }, now).cancellable).toBe(false);
    expect(cancelWindow({ mode: "TEST", status: "UNKNOWN", submittedAt: new Date("2129-06-09T10:05:00Z") }, now).cancellable).toBe(false);
  });
});
