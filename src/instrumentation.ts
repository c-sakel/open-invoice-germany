/**
 * Next.js 16 ruft `register()` automatisch beim Prozessstart auf (kein experimental-Flag
 * noetig, `src/instrumentation.ts` wird selbstaendig erkannt). Startet hier den
 * Scheduler-Intervall-Loop (Phase 6, Task 3) — aber NUR im Node-Runtime-Prozess (nicht in
 * der Edge-Runtime, die `register()` ebenfalls aufruft) und nur, wenn nicht per
 * `SCHEDULER_ENABLED=false` deaktiviert. `next build` ruft `register()` nicht auf; unter
 * vitest ist `NEXT_RUNTIME` nie gesetzt, der Guard verhindert also auch dort einen Start.
 */
// Nit (Fix-Welle): SCHEDULER_ENABLED ist Default AN (Opt-out) — vorher deaktivierte nur
// der exakte String "false"; "0"/"no"/"off" starteten den Loop trotzdem, entgegen der
// Erwartung an einen Opt-out-Schalter.
const SCHEDULER_DISABLED_VALUES = new Set(["false", "0", "no", "off"]);

/** Hoechstens so lange wird auf laufende Hintergrundaufgaben gewartet (unter der Kubernetes-Frist von 60 s). */
const SCHEDULER_STOP_TIMEOUT_MS = 45_000;
/** Mindestwartezeit vor dem Beenden, damit laufende HTTP-Anfragen (z. B. PDF-Erzeugung) fertig werden. */
const DEFAULT_SHUTDOWN_DRAIN_MS = 10_000;

function shutdownDrainMs(): number {
  const n = Number(process.env.SHUTDOWN_DRAIN_MS);
  return Number.isFinite(n) && n >= 0 && n <= SCHEDULER_STOP_TIMEOUT_MS ? n : DEFAULT_SHUTDOWN_DRAIN_MS;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const raw = process.env.SCHEDULER_ENABLED?.trim().toLowerCase();
  const schedulerEnabled = !(raw && SCHEDULER_DISABLED_VALUES.has(raw));
  let stopScheduler: ((timeoutMs: number) => Promise<string>) | null = null;
  if (schedulerEnabled) {
    const loop = await import("./domain/scheduler/loop");
    loop.startScheduler(Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? 15));
    stopScheduler = loop.stopScheduler;
  }

  // Geordnetes Herunterfahren: nur mit NEXT_MANUAL_SIG_HANDLE=true (Container-Entrypoint) uebernehmen
  // wir SIGTERM/SIGINT selbst; ohne die Variable beendet Next sofort wie bisher. Next schliesst den
  // HTTP-Server dann nicht mehr selbst: Kubernetes nimmt den Pod vor SIGTERM aus den Endpoints, und
  // die Mindestwartezeit laesst bereits laufende Anfragen zu Ende laufen. Der Handler wird auch bei
  // abgeschaltetem Scheduler registriert, sonst wuerde der Prozess erst per SIGKILL enden.
  if (process.env.NEXT_MANUAL_SIG_HANDLE === "true") {
    const shutdown = (signal: string): void => {
      void (async () => {
        console.log(`${signal}: laufende Anfragen und Hintergrundaufgaben werden zu Ende gefuehrt.`);
        const drain = new Promise<void>((resolve) => setTimeout(resolve, shutdownDrainMs()));
        const [outcome] = await Promise.all([stopScheduler ? stopScheduler(SCHEDULER_STOP_TIMEOUT_MS) : Promise.resolve("aus"), drain]);
        console.log(`Scheduler beendet (${outcome}).`);
        process.exit(0);
      })();
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  }
}
