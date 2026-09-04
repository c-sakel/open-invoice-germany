/**
 * Next.js 16 ruft `register()` automatisch beim Prozessstart auf (kein experimental-Flag
 * noetig, `src/instrumentation.ts` wird selbstaendig erkannt). Startet hier den
 * Scheduler-Intervall-Loop (Phase 6, Task 3) — aber NUR im Node-Runtime-Prozess (nicht in
 * der Edge-Runtime, die `register()` ebenfalls aufruft) und nur, wenn nicht per
 * `SCHEDULER_ENABLED=false` deaktiviert. `next build` ruft `register()` nicht auf; unter
 * vitest ist `NEXT_RUNTIME` nie gesetzt, der Guard verhindert also auch dort einen Start.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SCHEDULER_ENABLED === "false") return;
  const minutes = Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? 15);
  const { startScheduler } = await import("./domain/scheduler/loop");
  startScheduler(minutes);
}
