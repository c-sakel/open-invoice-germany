/**
 * Intervall-Loop des Schedulers (Phase 6, Task 3) — startet von `src/instrumentation.ts`
 * beim Prozessstart (nur `NEXT_RUNTIME === "nodejs"`, nie im Build/Test). Erster Lauf nach
 * 60 s, danach `setInterval`. `SchedulerRun` ist der DB-Lock ueber mehrere Prozesse hinweg;
 * dieses Modul verhindert zusaetzlich, dass EIN Prozess sich selbst ueberlappt (falls ein
 * Lauf laenger dauert als das Intervall) — ein reines In-Process-Flag, kein Ersatz fuer den
 * DB-Lock.
 *
 * `globalThis`-Singleton statt Modul-Closure: bei Next.js-HMR im Dev-Modus wird dieses
 * Modul bei jeder Codeaenderung neu ausgewertet — eine Modul-Closure wuerde bei jedem HMR
 * einen zweiten, parallelen `setInterval` starten. Der Zustand haengt am Prozess
 * (`globalThis`), nicht am Modul, und ueberlebt HMR-Neuladungen.
 */
import { runScheduledJobs } from "./runner";

interface SchedulerLoopState {
  started: boolean;
  running: boolean;
  stopping: boolean;
  /** Laufender Tick (fuer das geordnete Herunterfahren), sonst null. */
  current: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
  /** Einmaliger Starttimer (erster Lauf nach 60 s). */
  startTimer: ReturnType<typeof setTimeout> | null;
}

declare global {
  var __oigSchedulerLoop: SchedulerLoopState | undefined;
}

/** Startet den Intervall-Loop einmalig je Prozess. Weitere Aufrufe (z. B. durch HMR) sind No-Ops. */
export function startScheduler(minutes: number): void {
  if (globalThis.__oigSchedulerLoop?.started) return;

  const state: SchedulerLoopState = { started: true, running: false, stopping: false, current: null, timer: null, startTimer: null };
  globalThis.__oigSchedulerLoop = state;

  // S4 (Fix-Welle): ein Tippfehler in SCHEDULER_INTERVAL_MINUTES (z. B. "abc") ergibt
  // Number("abc") = NaN; Math.max(1, NaN) ist selbst wieder NaN (NaN-Vergleiche sind immer
  // false) — setInterval behandelt NaN wie 0 und feuert im Millisekundentakt gegen Postgres
  // (SchedulerLock/-Run je Tick). Robust: nur ein endlicher Wert >= 1 zaehlt, sonst Default 15.
  const safeMinutes = Number.isFinite(minutes) && minutes >= 1 ? minutes : 15;
  const intervalMs = safeMinutes * 60 * 1000;

  const tick = async (): Promise<void> => {
    if (state.stopping) return; // beim Herunterfahren kein neuer Lauf
    if (state.running) return; // nie zwei Laeufe gleichzeitig
    state.running = true;
    const run = (async (): Promise<void> => {
      try {
        await runScheduledJobs({ trigger: "SCHEDULER" });
      } catch (e) {
        console.error("Scheduler-Loop fehlgeschlagen:", e);
      } finally {
        state.running = false;
        state.current = null;
      }
    })();
    state.current = run;
    await run;
  };

  state.startTimer = setTimeout(() => {
    state.startTimer = null;
    if (state.stopping) return;
    void tick();
    state.timer = setInterval(() => void tick(), intervalMs);
  }, 60_000);
}

/** true, sobald das geordnete Herunterfahren begonnen hat (der Runner startet dann keinen weiteren Job). */
export function isSchedulerStopping(): boolean {
  return globalThis.__oigSchedulerLoop?.stopping === true;
}

/**
 * Geordnetes Herunterfahren: Timer loeschen, keine neuen Ticks/Jobs, auf den laufenden Tick
 * warten (hoechstens `timeoutMs`). Ein begonnener Job laeuft so zu Ende und gibt seine Sperre frei.
 */
export async function stopScheduler(timeoutMs = 45_000): Promise<"idle" | "finished" | "timeout"> {
  const state = globalThis.__oigSchedulerLoop;
  if (!state) return "idle";
  state.stopping = true;
  if (state.startTimer) clearTimeout(state.startTimer);
  if (state.timer) clearInterval(state.timer);
  state.startTimer = null;
  state.timer = null;
  const current = state.current;
  if (!current) return "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([current.then(() => "finished" as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
