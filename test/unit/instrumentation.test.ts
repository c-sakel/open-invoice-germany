/**
 * Nit (Fix-Welle, Phase 6) — `src/instrumentation.ts`: SCHEDULER_ENABLED ist Default AN
 * (Opt-out). Vorher deaktivierte nur der exakte String "false"; "0"/"no"/"off" starteten
 * den Loop trotzdem, entgegen dem .env.example-Kommentar "Default an" fuer einen
 * Opt-out-Schalter. `startScheduler` wird gemockt — dieser Test prueft nur, ob/mit
 * welchen Minuten register() ihn aufruft, nicht die Loop-Logik selbst (dafuer
 * test/unit/scheduler-loop.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const startSchedulerMock = vi.hoisted(() => vi.fn());
const stopSchedulerMock = vi.hoisted(() => vi.fn(async () => "idle"));
vi.mock("@/domain/scheduler/loop", () => ({
  startScheduler: startSchedulerMock,
  stopScheduler: stopSchedulerMock,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  startSchedulerMock.mockClear();
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.SCHEDULER_ENABLED;
  delete process.env.SCHEDULER_INTERVAL_MINUTES;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("register() (src/instrumentation.ts)", () => {
  it("nicht NEXT_RUNTIME=nodejs -> startScheduler wird nicht aufgerufen", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startSchedulerMock).not.toHaveBeenCalled();
  });

  it("SCHEDULER_ENABLED unset -> Default AN, startScheduler wird aufgerufen", async () => {
    const { register } = await import("@/instrumentation");
    await register();
    expect(startSchedulerMock).toHaveBeenCalledTimes(1);
  });

  for (const off of ["false", "0", "no", "off", "FALSE", "Off"]) {
    it(`SCHEDULER_ENABLED=${off} deaktiviert den Loop`, async () => {
      process.env.SCHEDULER_ENABLED = off;
      const { register } = await import("@/instrumentation");
      await register();
      expect(startSchedulerMock).not.toHaveBeenCalled();
    });
  }

  it("SCHEDULER_ENABLED=true startet den Loop", async () => {
    process.env.SCHEDULER_ENABLED = "true";
    const { register } = await import("@/instrumentation");
    await register();
    expect(startSchedulerMock).toHaveBeenCalledTimes(1);
  });
});

describe("Herunterfahren (NEXT_MANUAL_SIG_HANDLE=true)", () => {
  async function registerAndSigterm(env: Record<string, string>): Promise<{ exit: ReturnType<typeof vi.spyOn>; handlers: (() => void)[] }> {
    Object.assign(process.env, { NEXT_MANUAL_SIG_HANDLE: "true" }, env);
    const handlers: (() => void)[] = [];
    vi.spyOn(process, "once").mockImplementation(((ev: string, fn: () => void) => {
      if (ev === "SIGTERM") handlers.push(fn);
      return process;
    }) as typeof process.once);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { register } = await import("@/instrumentation");
    await register();
    return { exit, handlers };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("registriert den Handler auch bei abgeschaltetem Scheduler (sonst endete der Prozess erst per SIGKILL)", async () => {
    vi.useFakeTimers();
    const { exit, handlers } = await registerAndSigterm({ SCHEDULER_ENABLED: "off", SHUTDOWN_DRAIN_MS: "0" });
    expect(startSchedulerMock).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(1);
    handlers[0]();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("wartet die Mindestzeit ab, bevor der Prozess endet (laufende HTTP-Anfragen)", async () => {
    vi.useFakeTimers();
    const { exit, handlers } = await registerAndSigterm({ SHUTDOWN_DRAIN_MS: "10000" });
    handlers[0]();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(stopSchedulerMock).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
