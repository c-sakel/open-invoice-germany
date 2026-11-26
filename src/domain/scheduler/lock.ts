/**
 * Sperre eines Scheduler-Jobs fuer Einzelaufrufe (z. B. manueller Abruf nur einer Firma): dieselbe Sperre
 * (SchedulerLock.job) wie im Runner, damit kein Parallellauf mit dem regulaeren Job entsteht, und ein
 * SchedulerRun-Eintrag fuer das Protokoll. Der Runner selbst bleibt unveraendert.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { inflightJobs } from "./inflight";

export const STALE_MS = 30 * 60 * 1000;
/** Lebenszeichen der Sperre: solange der Job in diesem Prozess laeuft, wird `lockedAt` so oft erneuert. */
export const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Erneuert `lockedAt` periodisch, solange die Sperre diesem Lauf gehoert (job + runId im WHERE).
 * Verhindert, dass ein zweiter Pod (Rolling-Update) einen noch laufenden Job als "stale" uebernimmt.
 * Gibt die Stopp-Funktion zurueck; Fehler beim Erneuern werden nur protokolliert.
 */
export function startLockHeartbeat(job: string, runId: string, intervalMs: number = HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    dbInternal.schedulerLock
      .updateMany({ where: { job, runId }, data: { lockedAt: new Date() } })
      .catch((e: unknown) => console.error("scheduler: Sperre erneuern fehlgeschlagen", job, e instanceof Error ? e.name : "Fehler"));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function withJobLock<T extends Record<string, unknown>>(
  job: string,
  trigger: "MANUAL" | "SCHEDULER" | "CRON",
  _now: Date,
  fn: () => Promise<T>,
): Promise<{ locked: true } | { locked: false; value: T }> {
  // Der Job laeuft in diesem Prozess noch (z. B. nach Zeitueberschreitung des Runners): kein Parallellauf.
  if (inflightJobs().has(job)) return { locked: true };
  // Einheitlich Wanduhr (lockedAt/startedAt/finishedAt/Stale-Pruefung); der Parameter bleibt aus Kompatibilitaet.
  const threshold = new Date(Date.now() - STALE_MS);
  const stale = await dbInternal.schedulerLock.findFirst({ where: { job, lockedAt: { lt: threshold } } });
  if (stale) {
    // Nur wenn die Sperre dabei nicht gerade erneuert wurde (lockedAt im WHERE).
    const del = await dbInternal.schedulerLock.deleteMany({ where: { job, runId: stale.runId, lockedAt: { lt: threshold } } });
    if (del.count > 0) {
      await dbInternal.schedulerRun.updateMany({ where: { id: stale.runId, status: "RUNNING" }, data: { status: "FAILED", error: "stale", finishedAt: new Date() } });
    }
  }
  const runId = randomUUID();
  try {
    await dbInternal.schedulerLock.create({ data: { job, runId, lockedAt: new Date() } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { locked: true };
    throw e;
  }
  const stopHeartbeat = startLockHeartbeat(job, runId);
  try {
    await dbInternal.schedulerRun.create({ data: { id: runId, job, trigger, status: "RUNNING", startedAt: new Date() }, select: { id: true } });
    try {
      const value = await fn();
      await dbInternal.schedulerRun.update({ where: { id: runId }, data: { status: "OK", finishedAt: new Date(), summaryJson: JSON.stringify(value) }, select: { id: true } });
      return { locked: false, value };
    } catch (e) {
      await dbInternal.schedulerRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), error: e instanceof Error ? e.name : "Fehler" }, select: { id: true } });
      throw e;
    }
  } finally {
    stopHeartbeat();
    await dbInternal.schedulerLock.deleteMany({ where: { job, runId } });
  }
}
