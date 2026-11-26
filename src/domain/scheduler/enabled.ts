/** Ist der In-App-Scheduler aktiv? Standard AN (Opt-out ueber SCHEDULER_ENABLED=false/0/no/off). */
const SCHEDULER_DISABLED_VALUES = new Set(["false", "0", "no", "off"]);

export function isSchedulerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SCHEDULER_ENABLED?.trim().toLowerCase();
  return !(raw && SCHEDULER_DISABLED_VALUES.has(raw));
}
