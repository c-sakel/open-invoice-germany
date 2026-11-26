/** Sperre je Job, Zeitlimit und Schutz vor Parallellauf (runner.ts, lock.ts, inflight.ts). */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const jobsMock = vi.hoisted(() => ({ fx: vi.fn(), recurring: vi.fn(), dunning: vi.fn() }));
vi.mock("@/domain/scheduler/jobs", () => ({ jobs: jobsMock }));

import { dbInternal } from "@/lib/db";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import { withJobLock } from "@/domain/scheduler/lock";
import { inflightJobs } from "@/domain/scheduler/inflight";

const NOW = new Date("2321-03-10T08:00:00.000Z");
let orgId: string;

beforeAll(async () => {
  orgId = (await dbInternal.organization.create({ data: { legalName: "Timeout GmbH", addressLine1: "A", postalCode: "1", city: "A" } })).id;
});

beforeEach(async () => {
  for (const m of Object.values(jobsMock)) m.mockReset();
  await dbInternal.schedulerRun.deleteMany({});
  await dbInternal.schedulerLock.deleteMany({});
  await dbInternal.notification.deleteMany({ where: { type: "SCHEDULER_FAILED" } });
});

function hanging(): { release: () => void; fn: () => Promise<Record<string, unknown>> } {
  let release: () => void = () => undefined;
  const p = new Promise<void>((r) => {
    release = r;
  });
  return { release, fn: async () => (await p, { late: true }) };
}

describe("Scheduler-Zeitlimit", () => {
  it("haengender Job: FAILED timeout + Alarm, Sperre bleibt, Folgejobs laufen; Ende raeumt auf, Status bleibt FAILED", async () => {
    const h = hanging();
    jobsMock.fx.mockImplementation(h.fn);
    jobsMock.recurring.mockResolvedValue({ ok: 1 });
    jobsMock.dunning.mockResolvedValue({ ok: 2 });

    const results = await runScheduledJobs({ jobs: ["fx", "recurring", "dunning"], trigger: "MANUAL", now: NOW, jobTimeoutMs: 50 });
    expect(results.map((r) => [r.job, r.ok])).toEqual([["fx", false], ["recurring", true], ["dunning", true]]);
    expect(results[0].error).toBe("timeout");

    const fxRun = await dbInternal.schedulerRun.findFirstOrThrow({ where: { job: "fx" } });
    expect(fxRun.status).toBe("FAILED");
    expect(fxRun.error).toBe("timeout");
    expect(await dbInternal.notification.count({ where: { orgId, type: "SCHEDULER_FAILED" } })).toBe(1);
    expect(await dbInternal.schedulerLock.findUnique({ where: { job: "fx" } })).not.toBeNull();
    expect(inflightJobs().has("fx")).toBe(true);

    // Zweiter Lauf, waehrend der Job noch haengt: kein neuer Lauf, kein weiterer SchedulerRun, Einzelabruf gesperrt.
    const second = await runScheduledJobs({ jobs: ["fx"], trigger: "MANUAL", now: NOW, jobTimeoutMs: 50 });
    expect(second[0].summary.skipped).toBe("still-running");
    expect(jobsMock.fx).toHaveBeenCalledTimes(1);
    expect(await dbInternal.schedulerRun.count({ where: { job: "fx" } })).toBe(1);
    expect(await withJobLock("fx", "MANUAL", NOW, async () => ({}))).toEqual({ locked: true });

    h.release();
    await vi.waitFor(() => expect(inflightJobs().has("fx")).toBe(false));
    expect(await dbInternal.schedulerLock.findUnique({ where: { job: "fx" } })).toBeNull();
    const after = await dbInternal.schedulerRun.findFirstOrThrow({ where: { job: "fx" } });
    expect(after.status).toBe("FAILED");
    expect(after.error).toBe("timeout");
  });

  it("lockedAt je Job: der spaetere Job hat die spaetere Sperrzeit", async () => {
    jobsMock.fx.mockImplementation(async () => (await new Promise((r) => setTimeout(r, 60)), {}));
    jobsMock.recurring.mockResolvedValue({});
    jobsMock.dunning.mockResolvedValue({});
    await runScheduledJobs({ jobs: ["fx", "recurring", "dunning"], trigger: "MANUAL", now: NOW });
    const runs = await dbInternal.schedulerRun.findMany({ select: { job: true, startedAt: true } });
    const at = (j: string) => runs.find((r) => r.job === j)!.startedAt.getTime();
    expect(at("dunning")).toBeGreaterThan(at("fx"));
  });

  it("Sperre ohne Eintrag in der Liste (Prozessneustart), 31 min alt: wird abgeraeumt", async () => {
    const old = new Date(Date.now() - 31 * 60_000);
    await dbInternal.schedulerRun.create({ data: { id: "stale-23c-t5", job: "fx", trigger: "SCHEDULER", status: "RUNNING", startedAt: old } });
    await dbInternal.schedulerLock.create({ data: { job: "fx", runId: "stale-23c-t5", lockedAt: old } });
    jobsMock.fx.mockResolvedValue({});
    const r = await runScheduledJobs({ jobs: ["fx"], trigger: "MANUAL", now: NOW });
    expect(r[0].ok).toBe(true);
    expect(r[0].summary.skipped).toBeUndefined();
    const run = await dbInternal.schedulerRun.findUniqueOrThrow({ where: { id: "stale-23c-t5" } });
    expect(run.error).toBe("stale");
  });

  it("Heartbeat: lockedAt wird waehrend des laufenden Jobs erneuert; Stale-Pruefung eines zweiten Prozesses uebernimmt nicht", async () => {
    const h = hanging();
    jobsMock.fx.mockImplementation(h.fn);
    await runScheduledJobs({ jobs: ["fx"], trigger: "MANUAL", now: NOW, jobTimeoutMs: 40, heartbeatMs: 20 });
    const lock = await dbInternal.schedulerLock.findUniqueOrThrow({ where: { job: "fx" } });
    await vi.waitFor(async () => {
      const cur = await dbInternal.schedulerLock.findUniqueOrThrow({ where: { job: "fx" } });
      expect(cur.lockedAt.getTime()).toBeGreaterThan(lock.lockedAt.getTime());
    });
    // Zweiter Prozess: kein Eintrag in der Liste, Sperre ist frisch -> "locked", Lauf des ersten bleibt unangetastet.
    inflightJobs().delete("fx");
    jobsMock.fx.mockResolvedValue({});
    const second = await runScheduledJobs({ jobs: ["fx"], trigger: "MANUAL", now: NOW });
    expect(second[0].summary.skipped).toBe("locked");
    expect((await dbInternal.schedulerRun.findUniqueOrThrow({ where: { id: lock.runId } })).error).toBe("timeout");
    h.release();
    await vi.waitFor(async () => expect(await dbInternal.schedulerLock.findUnique({ where: { job: "fx" } })).toBeNull());
  });

  it("Fehler beim Freigeben: keine unhandled rejection, gebuchtes Ergebnis bleibt", async () => {
    jobsMock.fx.mockResolvedValue({ ok: 1 });
    const spy = vi.spyOn(dbInternal.schedulerLock, "deleteMany").mockRejectedValueOnce(new Error("db weg"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await runScheduledJobs({ jobs: ["fx"], trigger: "MANUAL", now: NOW });
    expect(r[0].ok).toBe(true);
    expect((await dbInternal.schedulerRun.findFirstOrThrow({ where: { job: "fx" } })).status).toBe("OK");
    expect(inflightJobs().has("fx")).toBe(false);
    expect(err).toHaveBeenCalled();
    spy.mockRestore();
    err.mockRestore();
  });

  it("spaeter Fehler nach Zeitlimit: Status bleibt timeout, Fehler wird protokolliert", async () => {
    let fail: () => void = () => undefined;
    jobsMock.fx.mockImplementation(() => new Promise((_, rej) => { fail = () => rej(new Error("spaet")); }));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runScheduledJobs({ jobs: ["fx"], trigger: "MANUAL", now: NOW, jobTimeoutMs: 30 });
    fail();
    await vi.waitFor(() => expect(inflightJobs().has("fx")).toBe(false));
    expect((await dbInternal.schedulerRun.findFirstOrThrow({ where: { job: "fx" } })).error).toBe("timeout");
    expect(err.mock.calls.some((c) => String(c[0]).includes("nach Zeitlimit"))).toBe(true);
    err.mockRestore();
  });
});
