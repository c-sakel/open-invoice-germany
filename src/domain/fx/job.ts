/**
 * Scheduler-Job `fx` (Phase 16b): taeglicher EZB-Kursabruf mit Monatsmittel. Der Job wirft nie —
 * Netz-/Formatfehler werden als `{ error }` ins Laufprotokoll geschrieben und als
 * Benachrichtigung `FX_FETCH_FAILED` gemeldet; die uebrigen Jobs laufen weiter.
 *
 * "Letzter Abruf" stammt aus dem Laufprotokoll (`SchedulerRun`, Summary `fetched: true`), nicht
 * aus `ExchangeRate.fetchedAt`: an Wochenenden/Feiertagen bringt die EZB keine neuen Zeilen,
 * der Zeitstempel der Kurse wuerde dann veralten und den Abruf bei jedem Tick (15 Min.) ausloesen.
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { createNotification } from "@/domain/notifications/create";
import { loadNotificationSettings } from "@/domain/notifications/settings";
import { shouldFetchFx } from "./fetch-ecb";
import { refreshExchangeRates } from "./store";

const RETRY_BACKOFF_MS = 30 * 60 * 1000;
const summarySchema = z.object({ fetched: z.literal(true).optional(), error: z.string().optional() }).passthrough();

async function notifyFailure(message: string, now: Date): Promise<void> {
  try {
    const orgs = await dbInternal.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      const settings = await loadNotificationSettings(org.id);
      if (!settings.enabledTypes.includes("FX_FETCH_FAILED")) continue;
      await createNotification({
        orgId: org.id,
        type: "FX_FETCH_FAILED",
        title: "Wechselkurs-Abruf fehlgeschlagen",
        body: message.slice(0, 500),
        dedupeKey: `fx-fetch-failed:${now.toISOString().slice(0, 10)}`,
        at: now,
      });
    }
  } catch (e) {
    console.error("fx: Benachrichtigung fehlgeschlagen", e);
  }
}

export async function runFxJob(now: Date, fetchImpl?: typeof fetch): Promise<Record<string, unknown>> {
  if (process.env.FX_AUTO_FETCH === "0") return { skipped: "disabled" };

  const recent = await dbInternal.schedulerRun.findMany({
    where: { job: "fx", status: "OK" },
    orderBy: { startedAt: "desc" },
    take: 20,
    select: { startedAt: true, summaryJson: true },
  });
  let lastOk: Date | null = null;
  let lastFail: Date | null = null;
  for (const run of recent) {
    if (!run.summaryJson) continue;
    let parsed: z.infer<typeof summarySchema>;
    try {
      parsed = summarySchema.parse(JSON.parse(run.summaryJson));
    } catch {
      continue;
    }
    if (parsed.fetched && !lastOk) lastOk = run.startedAt;
    if (parsed.error && !lastFail) lastFail = run.startedAt;
  }
  if (lastFail && (!lastOk || lastFail > lastOk) && now.getTime() - lastFail.getTime() < RETRY_BACKOFF_MS) {
    return { skipped: "backoff" };
  }
  if (!shouldFetchFx(now, lastOk)) return { skipped: "not-due" };

  try {
    const result = await refreshExchangeRates(now, fetchImpl);
    return { fetched: true, ...result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await notifyFailure(message, now);
    return { error: message };
  }
}
