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

import { startScheduler } from "@/domain/scheduler/loop";

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
