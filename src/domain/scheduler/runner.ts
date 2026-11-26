/**
 * Scheduler-Runner (Phase 6, Task 3) — fuehrt die registrierten Jobs (`jobs.ts`) seriell in
 * fester Reihenfolge (`fx` -> `recurring` -> `dunning` -> `archive` -> `notifications`) aus und protokolliert jeden Lauf in
 * `SchedulerRun`. Wird sowohl vom Intervall-Loop (`loop.ts`/`instrumentation.ts`) als auch
 * von den Cron-Routen, der manuellen API-Route und den CLI-Skripten aufgerufen — EINE
 * Implementierung, kein zweiter Ausfuehrungspfad.
 *
 * Lock (Fix Runde 1): ausschliesslich ueber den Unique-Constraint von `SchedulerLock.job`
 * (Primaerschluessel). Die vorherige Praxis — `SchedulerRun.findFirst({status:"RUNNING"})`
 * gefolgt von `create` — war unter Postgres READ COMMITTED NICHT atomar: zwei gleichzeitige
 * Laeufe konnten beide die Lesepruefung passieren, bevor einer schrieb. `schedulerLock.create`
 * schlaegt bei bereits bestehendem Lock stattdessen mit einer Unique-Constraint-Verletzung
 * (Prisma P2002) fehl — DAS ist die tatsaechliche, atomare Entscheidung, nicht die
 * vorgelagerte Pruefung. Ein `RUNNING`-Eintrag desselben Jobs, dessen Lock aelter als 30
 * Minuten ist ("stale"), wird VOR dem Erwerbsversuch entfernt (Lock geloescht, zugehoeriger
 * `SchedulerRun` auf FAILED("stale") gesetzt); danach laeuft der Job normal. Der Lock wird
 * im `finally` freigegeben (geloescht ueber `job` + `runId`, damit ein inzwischen neu
 * erworbener Lock desselben Jobs nicht versehentlich mitgeloescht wird). Ein Fehler in einem
 * Job bricht die anderen Jobs NICHT ab (try/catch je Job in der Schleife).
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { onSchedulerFailed } from "@/domain/notifications/hooks";
import { jobs } from "./jobs";
import { isSchedulerStopping } from "./loop";
import { inflightJobs } from "./inflight";

export type SchedulerJob = "fx" | "dunning" | "postal" | "recurring" | "auto-send" | "archive" | "mailbox" | "bank-fetch" | "online-payments" | "payment-rules" | "notifications" | "webhooks" | "audit" | "cleanup";

export interface JobResult {
  job: SchedulerJob;
  ok: boolean;
  summary: Record<string, unknown>;
  error?: string;
  /** Id des `SchedulerRun`-Eintrags (fehlt nur bei `summary.skipped === "locked"`). */
  runId?: string;
}

// "fx" (Phase 16b) laeuft als ERSTER Job: aktuelle Wechselkurse liegen vor, bevor Abo-Rechnungen
// in Fremdwaehrung erzeugt werden. Reihenfolge (Task-3-Facts, erweitert um Task-5-Facts): recurring -> dunning ->
// notifications -> webhooks — Benachrichtigungen (faellig/ueberfaellig/Mahnstufe) sollen
// den Stand NACH den beiden vorgelagerten Jobs desselben Laufs widerspiegeln (frisch
// erzeugte Abo-Rechnungen/Mahnungen); "webhooks" (Zustellung der Outbox) laeuft zuletzt,
// damit Ereignisse aus recurring/dunning/notifications noch IM SELBEN Lauf mit ausgeliefert
// werden koennen (die Ereignisse selbst entstehen bereits transaktional bei ihrer Aktion,
// "webhooks" liefert hier nur die bereits angelegten Outbox-Zeilen aus). "cleanup" (Fix-
// Welle, Should-fix 7) laeuft als LETZTER Job — raeumt WebhookDelivery/ApiIdempotency auf,
// nie eine Zeile, die derselbe Lauf gerade erst als faellig behandelt hat.
export const JOB_ORDER: SchedulerJob[] = ["fx", "recurring", "auto-send", "dunning", "postal", "archive", "mailbox", "bank-fetch", "online-payments", "payment-rules", "notifications", "webhooks", "audit", "cleanup"];
const STALE_MS = 30 * 60 * 1000;
/** Zeitlimit je Job. Danach: FAILED "timeout" + Alarm; die Sperre bleibt bis zum tatsaechlichen Ende. */
export const JOB_TIMEOUT_MS = 20 * 60 * 1000;

export interface RunScheduledJobsOptions {
  jobs?: SchedulerJob[];
  trigger: "SCHEDULER" | "CRON" | "MANUAL";
  now?: Date;
  /** Nur fuer Tests: Zeitlimit je Job (Standard `JOB_TIMEOUT_MS`). */
  jobTimeoutMs?: number;
}

function isUniqueConstraintError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Entfernt einen "stale" Lock (aelter als 30 Min) VOR dem Erwerbsversuch und markiert den
 *  zugehoerigen SchedulerRun-Eintrag als FAILED("stale") — wie zuvor, nur jetzt am Lock statt
 *  am SchedulerRun-Status festgemacht. */
async function clearStaleLock(job: SchedulerJob, now: Date): Promise<void> {
  const threshold = new Date(now.getTime() - STALE_MS);
  const stale = await dbInternal.schedulerLock.findFirst({ where: { job, lockedAt: { lt: threshold } } });
  if (!stale) return;
  await dbInternal.schedulerRun.updateMany({
    where: { id: stale.runId, status: "RUNNING" },
    data: { status: "FAILED", error: "stale", finishedAt: now },
  });
  await dbInternal.schedulerLock.deleteMany({ where: { job, runId: stale.runId } });
  await alertOnRepeatedFailure(job, stale.runId, now);
}

/**
 * Meldet eine Hintergrundaufgabe, deren letzte zwei Laeufe beide fehlgeschlagen sind (Pflicht-Alarm,
 * je Aufgabe und Berliner Tag eine Meldung). Ein Fehler hier bricht den Lauf nie ab.
 */
async function alertOnRepeatedFailure(job: SchedulerJob, runId: string, now: Date): Promise<void> {
  try {
    const last = await dbInternal.schedulerRun.findMany({
      where: { job },
      orderBy: { startedAt: "desc" },
      take: 2,
      select: { status: true },
    });
    if (last.length === 2 && last.every((r) => r.status === "FAILED")) await onSchedulerFailed(job, runId, now);
  } catch (e) {
    console.error("scheduler: Alarmpruefung fehlgeschlagen", e instanceof Error ? e.name : "Fehler");
  }
}

export async function runScheduledJobs(opts: RunScheduledJobsOptions): Promise<JobResult[]> {
  const now = opts.now ?? new Date();
  const timeoutMs = opts.jobTimeoutMs ?? JOB_TIMEOUT_MS;
  const wanted = opts.jobs ? new Set(opts.jobs) : null;
  const order = JOB_ORDER.filter((j) => !wanted || wanted.has(j));
  const inflight = inflightJobs();

  const results: JobResult[] = [];
  for (const job of order) {
    // Geordnetes Herunterfahren: begonnene Jobs laufen zu Ende, neue starten nicht (kein SchedulerRun).
    if (isSchedulerStopping()) {
      results.push({ job, ok: true, summary: { skipped: "shutdown" } });
      continue;
    }
    // Der Job laeuft in diesem Prozess noch (z. B. nach Zeitueberschreitung): weder neu starten noch Sperre abraeumen.
    if (inflight.has(job)) {
      results.push({ job, ok: true, summary: { skipped: "still-running" } });
      continue;
    }
    await clearStaleLock(job, new Date());

    const runId = randomUUID();
    const startedAt = new Date();
    try {
      await dbInternal.schedulerLock.create({ data: { job, runId, lockedAt: startedAt } });
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        results.push({ job, ok: true, summary: { skipped: "locked" } });
        continue;
      }
      throw e;
    }

    const release = async (): Promise<void> => {
      try {
        await dbInternal.schedulerLock.deleteMany({ where: { job, runId } });
      } finally {
        inflight.delete(job);
      }
    };

    let entryId: string;
    try {
      const entry = await dbInternal.schedulerRun.create({
        data: { id: runId, job, trigger: opts.trigger, status: "RUNNING", startedAt },
      });
      entryId = entry.id;
    } catch (e) {
      await release();
      throw e;
    }

    // Fachlich bleibt `now` (Stichtag) fuer den Job; die Sperre haengt an der tatsaechlichen Laufzeit.
    type Outcome = { ok: true; summary: Record<string, unknown> } | { ok: false; error: string };
    const settled: Promise<Outcome> = (async () => jobs[job](now))().then(
      (summary): Outcome => ({ ok: true, summary }),
      (e: unknown): Outcome => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    // Sperre und Eintrag in der Liste enden erst, wenn der Job WIRKLICH fertig ist (auch nach Zeitueberschreitung).
    const tail = settled.then(release, release);
    inflight.set(job, tail);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      // Sperre NICHT loeschen: der Job laeuft evtl. noch (Doppelversand-Gefahr). Spaeteres Ergebnis aendert FAILED nicht.
      await dbInternal.schedulerRun.updateMany({
        where: { id: entryId, status: "RUNNING" },
        data: { status: "FAILED", finishedAt: new Date(), error: "timeout" },
      });
      results.push({ job, ok: false, summary: {}, error: "timeout", runId: entryId });
      await onSchedulerFailed(job, entryId, now);
      continue;
    }

    try {
      if (outcome.ok) {
        // finishedAt = tatsaechlicher Abschlusszeitpunkt (nicht `now`).
        await dbInternal.schedulerRun.updateMany({
          where: { id: entryId, status: "RUNNING" },
          data: { status: "OK", finishedAt: new Date(), summaryJson: JSON.stringify(outcome.summary) },
        });
        results.push({ job, ok: true, summary: outcome.summary, runId: entryId });
      } else {
        await dbInternal.schedulerRun.updateMany({
          where: { id: entryId, status: "RUNNING" },
          data: { status: "FAILED", finishedAt: new Date(), error: outcome.error },
        });
        results.push({ job, ok: false, summary: {}, error: outcome.error, runId: entryId });
        await alertOnRepeatedFailure(job, entryId, now);
      }
    } finally {
      await tail;
    }
  }
  return results;
}
