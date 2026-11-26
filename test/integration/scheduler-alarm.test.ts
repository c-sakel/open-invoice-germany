/** Alarm bei zwei aufeinanderfolgenden Fehlern einer Hintergrundaufgabe (runner.ts). */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const jobsMock = vi.hoisted(() => ({ dunning: vi.fn(), recurring: vi.fn() }));
vi.mock("@/domain/scheduler/jobs", () => ({ jobs: jobsMock }));

import { dbInternal } from "@/lib/db";
import { runScheduledJobs } from "@/domain/scheduler/runner";

const T0 = new Date("2272-03-10T08:00:00.000Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

let orgA: string;
let orgB: string;

beforeAll(async () => {
  orgA = (await dbInternal.organization.create({ data: { legalName: "Sched A GmbH", addressLine1: "A", postalCode: "1", city: "A" } })).id;
  orgB = (await dbInternal.organization.create({ data: { legalName: "Sched B GmbH", addressLine1: "B", postalCode: "1", city: "B" } })).id;
});

beforeEach(async () => {
  jobsMock.dunning.mockReset();
  jobsMock.recurring.mockReset();
  await dbInternal.schedulerRun.deleteMany({});
  await dbInternal.schedulerLock.deleteMany({});
  await dbInternal.notification.deleteMany({ where: { type: "SCHEDULER_FAILED" } });
});

const count = (orgId: string) => dbInternal.notification.count({ where: { orgId, type: "SCHEDULER_FAILED" } });

describe("SCHEDULER_FAILED", () => {
  it("1. einmal -> keine Meldung; zweimal -> eine je Org; dritter Fehler am selben Tag -> keine weitere", async () => {
    jobsMock.dunning.mockRejectedValue(new Error("boom"));
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(0) });
    expect(await count(orgA)).toBe(0);
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(5) });
    expect(await count(orgA)).toBe(1);
    expect(await count(orgB)).toBe(1);
    const n = await dbInternal.notification.findFirstOrThrow({ where: { orgId: orgA, type: "SCHEDULER_FAILED" } });
    expect(n.body).not.toContain("boom");
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(10) });
    expect(await count(orgA)).toBe(1);
  });

  it("2. FAILED, OK, FAILED -> keine Meldung", async () => {
    jobsMock.dunning.mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error("y"));
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(0) });
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(5) });
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(10) });
    expect(await count(orgA)).toBe(0);
  });

  it("3. Stale-Lock zaehlt als FAILED", async () => {
    jobsMock.dunning.mockRejectedValueOnce(new Error("x")).mockResolvedValue({ ok: true });
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(0) });
    // haengender Lauf: RUNNING + alter Lock, jeweils nach dem ersten Fehler
    await dbInternal.schedulerRun.create({ data: { id: "stale-run-22c", job: "dunning", trigger: "MANUAL", status: "RUNNING", startedAt: min(10) } });
    await dbInternal.schedulerLock.create({ data: { job: "dunning", runId: "stale-run-22c", lockedAt: new Date(Date.now() - 31 * 60_000) } });
    await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(60) });
    expect(await count(orgA)).toBe(1);
  });

  it("4. Fehler in der Alarmpruefung (DB-Abfrage wirft) bricht den Runner nicht ab", async () => {
    jobsMock.dunning.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(dbInternal.schedulerRun, "findMany").mockRejectedValue(new Error("db weg"));
    try {
      const results = await runScheduledJobs({ jobs: ["dunning"], trigger: "MANUAL", now: min(0) });
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(await count(orgA)).toBe(0);
  });
});
