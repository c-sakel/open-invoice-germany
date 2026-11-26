/**
 * Sperre eines Scheduler-Jobs fuer Einzelaufrufe (z. B. manueller Abruf nur einer Firma): dieselbe Sperre
 * (SchedulerLock.job) wie im Runner, damit kein Parallellauf mit dem regulaeren Job entsteht, und ein
 * SchedulerRun-Eintrag fuer das Protokoll. Der Runner selbst bleibt unveraendert.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { inflightJobs } from "./inflight";

const STALE_MS = 30 * 60 * 1000;

export async function withJobLock<T extends Record<string, unknown>>(
  job: string,
  trigger: "MANUAL" | "SCHEDULER" | "CRON",
  now: Date,
  fn: () => Promise<T>,
): Promise<{ locked: true } | { locked: false; value: T }> {
  // Der Job laeuft in diesem Prozess noch (z. B. nach Zeitueberschreitung des Runners): kein Parallellauf.
  if (inflightJobs().has(job)) return { locked: true };
  const stale = await dbInternal.schedulerLock.findFirst({ where: { job, lockedAt: { lt: new Date(now.getTime() - STALE_MS) } } });
  if (stale) {
    await dbInternal.schedulerRun.updateMany({ where: { id: stale.runId, status: "RUNNING" }, data: { status: "FAILED", error: "stale", finishedAt: now } });
    await dbInternal.schedulerLock.deleteMany({ where: { job, runId: stale.runId } });
  }
  const runId = randomUUID();
  try {
    await dbInternal.schedulerLock.create({ data: { job, runId, lockedAt: new Date() } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { locked: true };
    throw e;
  }
  try {
    await dbInternal.schedulerRun.create({ data: { id: runId, job, trigger, status: "RUNNING", startedAt: now }, select: { id: true } });
    try {
      const value = await fn();
      await dbInternal.schedulerRun.update({ where: { id: runId }, data: { status: "OK", finishedAt: new Date(), summaryJson: JSON.stringify(value) }, select: { id: true } });
      return { locked: false, value };
    } catch (e) {
      await dbInternal.schedulerRun.update({ where: { id: runId }, data: { status: "FAILED", finishedAt: new Date(), error: e instanceof Error ? e.name : "Fehler" }, select: { id: true } });
      throw e;
    }
  } finally {
    await dbInternal.schedulerLock.deleteMany({ where: { job, runId } });
  }
}
