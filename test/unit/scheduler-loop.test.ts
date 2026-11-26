/**
 * Phase 6, Task 3 — Intervall-Loop (`domain/scheduler/loop.ts`): globalThis-Singleton
 * (HMR-sicher, `startScheduler` ist bei mehrfachem Aufruf ein No-Op) und Zeitplan
 * (erster Lauf nach 60 s, danach im Intervall). `runScheduledJobs` wird gemockt — dieser
 * Test prueft nur das Timing/Singleton-Verhalten des Loops, nicht die Job-Logik selbst
 * (dafuer test/integration/scheduler.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runScheduledJobsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock("@/domain/scheduler/runner", () => ({
  runScheduledJobs: runScheduledJobsMock,
}));

import { startScheduler, stopScheduler, isSchedulerStopping } from "@/domain/scheduler/loop";
import { inflightJobs } from "@/domain/scheduler/inflight";

beforeEach(() => {
  vi.useFakeTimers();
  runScheduledJobsMock.mockClear();
  delete (globalThis as { __oigSchedulerLoop?: unknown }).__oigSchedulerLoop;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startScheduler (Phase 6, Task 3)", () => {
  it("erster Lauf erst nach 60s, dann im Intervall", async () => {
    startScheduler(15);
    expect(runScheduledJobsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);
    expect(runScheduledJobsMock).toHaveBeenCalledWith({ trigger: "SCHEDULER" });

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(2);
  });

  it("globalThis-Singleton: zweiter Aufruf startet keinen zweiten Loop", async () => {
    startScheduler(15);
    startScheduler(15); // No-Op, schon gestartet

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1); // nicht 2
  });

  // S4 (Fix-Welle): NaN (Tippfehler in SCHEDULER_INTERVAL_MINUTES) faellt auf 15 zurueck
  // statt setInterval mit NaN (~0ms, Dauerlast) zu starten.
  it("NaN-Minuten (Tippfehler) faellt auf 15-Minuten-Intervall zurueck, statt im Millisekundentakt zu feuern", async () => {
    startScheduler(Number("nicht-numerisch"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);

    // Waere das Intervall NaN (~0ms), haetten hier bereits viele weitere Ticks gefeuert.
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 1000); // insgesamt 15 Min nach dem ersten Tick
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(2);
  });

  it("Minuten < 1 (z. B. 0) faellt auf 15-Minuten-Intervall zurueck", async () => {
    startScheduler(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(2);
  });

  it("nie zwei Laeufe gleichzeitig: laufender Tick blockiert den naechsten", async () => {
    let resolveFirst!: () => void;
    runScheduledJobsMock.mockReturnValueOnce(new Promise<void>((resolve) => { resolveFirst = resolve; }));

    startScheduler(1); // 1-Minuten-Intervall
    await vi.advanceTimersByTimeAsync(60_000); // erster Tick startet, haengt noch
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000); // naechstes Intervall waehrend erster Tick noch laeuft
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1); // uebersprungen (state.running)

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe("stopScheduler (geordnetes Herunterfahren)", () => {
  it("ohne laufenden Tick -> idle, danach startet kein Tick mehr", async () => {
    startScheduler(1);
    expect(isSchedulerStopping()).toBe(false);
    expect(await stopScheduler()).toBe("idle");
    expect(isSchedulerStopping()).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runScheduledJobsMock).not.toHaveBeenCalled();
  });

  it("ohne gestarteten Loop -> idle", async () => {
    expect(await stopScheduler()).toBe("idle");
  });

  it("laufender Tick: wartet und meldet finished, wenn er endet; kein weiterer Tick", async () => {
    let resolveRun!: () => void;
    runScheduledJobsMock.mockReturnValueOnce(new Promise<void>((resolve) => { resolveRun = resolve; }));
    startScheduler(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);

    let result: string | undefined;
    const stopping = stopScheduler(45_000).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result).toBeUndefined(); // wartet noch

    resolveRun();
    await stopping;
    expect(result).toBe("finished");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runScheduledJobsMock).toHaveBeenCalledTimes(1);
  });

  it("haengender Tick: timeout nach der Frist", async () => {
    runScheduledJobsMock.mockReturnValueOnce(new Promise<void>(() => {}));
    startScheduler(1);
    await vi.advanceTimersByTimeAsync(60_000);

    let result: string | undefined;
    const stopping = stopScheduler(45_000).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
    expect(result).toBe("timeout");
  });

  it("wartet auf Jobs der Inflight-Liste (manueller Lauf), ohne eigenen Tick", async () => {
    let resolveJob!: () => void;
    const job = new Promise<void>((resolve) => { resolveJob = resolve; });
    inflightJobs().set("test-job", job);
    try {
      startScheduler(1);
      let result: string | undefined;
      const stopping = stopScheduler(45_000).then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(result).toBeUndefined();
      resolveJob();
      await stopping;
      expect(result).toBe("finished");
    } finally {
      inflightJobs().delete("test-job");
    }
  });

  it("haengender Inflight-Job -> timeout", async () => {
    inflightJobs().set("test-job-2", new Promise<void>(() => {}));
    try {
      let result: string | undefined;
      const stopping = stopScheduler(5_000).then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      expect(result).toBe("timeout");
    } finally {
      inflightJobs().delete("test-job-2");
    }
  });
});
