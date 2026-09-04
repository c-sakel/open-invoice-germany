/**
 * Scheduler-Runner (Phase 6, Task 3) — fuehrt die registrierten Jobs (`jobs.ts`) seriell in
 * fester Reihenfolge (`recurring` -> `dunning`) aus und protokolliert jeden Lauf in
 * `SchedulerRun`. Wird sowohl vom Intervall-Loop (`loop.ts`/`instrumentation.ts`) als auch
 * von den Cron-Routen, der manuellen API-Route und den CLI-Skripten aufgerufen — EINE
 * Implementierung, kein zweiter Ausfuehrungspfad.
 *
 * Lock: ausschliesslich ueber `SchedulerRun` (kein In-Memory-Lock als einzige Sicherung,
 * mehrere Prozesse sind unter Postgres moeglich). Ein RUNNING-Eintrag desselben Jobs, der
 * juenger als 30 Minuten ist, laesst den Job aus (`summary: { skipped: "locked" }`); ein
 * aelterer ("stale") wird auf FAILED gesetzt und der Job laeuft trotzdem. Ein Fehler in
 * einem Job bricht die anderen Jobs NICHT ab (try/catch je Job in der Schleife).
 */
import { dbInternal } from "@/lib/db";
import { jobs } from "./jobs";

export type SchedulerJob = "dunning" | "recurring";

export interface JobResult {
  job: SchedulerJob;
  ok: boolean;
  summary: Record<string, unknown>;
  error?: string;
  /** Id des `SchedulerRun`-Eintrags (fehlt nur bei `summary.skipped === "locked"`). */
  runId?: string;
}

const JOB_ORDER: SchedulerJob[] = ["recurring", "dunning"];
const STALE_MS = 30 * 60 * 1000;

export interface RunScheduledJobsOptions {
  jobs?: SchedulerJob[];
  trigger: "SCHEDULER" | "CRON" | "MANUAL";
  now?: Date;
}

export async function runScheduledJobs(opts: RunScheduledJobsOptions): Promise<JobResult[]> {
  const now = opts.now ?? new Date();
  const wanted = opts.jobs ? new Set(opts.jobs) : null;
  const order = JOB_ORDER.filter((j) => !wanted || wanted.has(j));

  const results: JobResult[] = [];
  for (const job of order) {
    const running = await dbInternal.schedulerRun.findFirst({
      where: { job, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    if (running) {
      const isStale = running.startedAt.getTime() <= now.getTime() - STALE_MS;
      if (!isStale) {
        results.push({ job, ok: true, summary: { skipped: "locked" } });
        continue;
      }
      await dbInternal.schedulerRun.update({
        where: { id: running.id },
        data: { status: "FAILED", error: "stale", finishedAt: now },
      });
    }

    const entry = await dbInternal.schedulerRun.create({
      data: { job, trigger: opts.trigger, status: "RUNNING", startedAt: now },
    });

    try {
      const summary = await jobs[job](now);
      await dbInternal.schedulerRun.update({
        where: { id: entry.id },
        data: { status: "OK", finishedAt: now, summaryJson: JSON.stringify(summary) },
      });
      results.push({ job, ok: true, summary, runId: entry.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await dbInternal.schedulerRun.update({
        where: { id: entry.id },
        data: { status: "FAILED", finishedAt: now, error: message },
      });
      results.push({ job, ok: false, summary: {}, error: message, runId: entry.id });
    }
  }
  return results;
}
