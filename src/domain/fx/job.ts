/**
 * Scheduler-Job `fx` (Phase 16b): taeglicher EZB-Kursabruf mit Monatsmittel. Der Job wirft nie —
 * Netz-/Formatfehler werden als `{ error }` ins Laufprotokoll geschrieben und als
 * Benachrichtigung `FX_FETCH_FAILED` gemeldet; die uebrigen Jobs laufen weiter.
 *
 * "Letzter Abruf" stammt aus dem Laufprotokoll (`SchedulerRun`, Summary `fetched: true`), nicht
 * aus `ExchangeRate.fetchedAt`: an Wochenenden/Feiertagen bringt die EZB keine neuen Zeilen,
 * der Zeitstempel der Kurse wuerde dann veralten und den Abruf bei jedem Tick (15 Min.) ausloesen.
 */
import { dbInternal } from "@/lib/db";
import { createNotification } from "@/domain/notifications/create";
import { loadNotificationSettings } from "@/domain/notifications/settings";
import { shouldFetchFx } from "./fetch-ecb";
import { MIN_DAILY_RATES_FOR_MONTH, ensurePreviousMonthAverage, refreshExchangeRates } from "./store";

const RETRY_BACKOFF_MS = 30 * 60 * 1000;

async function notifyFailure(title: string, message: string, dedupeKey: string, now: Date): Promise<void> {
  try {
    const orgs = await dbInternal.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      const settings = await loadNotificationSettings(org.id);
      if (!settings.enabledTypes.includes("FX_FETCH_FAILED")) continue; // Pflicht-Alarm: immer enthalten
      await createNotification({
        orgId: org.id,
        type: "FX_FETCH_FAILED",
        title,
        body: message.slice(0, 500),
        dedupeKey,
        at: now,
      });
    }
  } catch (e) {
    console.error("fx: Benachrichtigung fehlgeschlagen", e);
  }
}

export async function runFxJob(now: Date, fetchImpl?: typeof fetch): Promise<Record<string, unknown>> {
  if (process.env.FX_AUTO_FETCH === "0") return { skipped: "disabled" };

  // Gezielt: letzter echter Abruf (fetched:true) und letzter Fehlversuch, je ein Lauf.
  const lastRun = async (marker: string): Promise<Date | null> => {
    const run = await dbInternal.schedulerRun.findFirst({
      where: { job: "fx", status: "OK", summaryJson: { contains: marker } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    return run?.startedAt ?? null;
  };
  const lastOk = await lastRun('"fetched":true');
  const lastFail = await lastRun('"error":');
  if (lastFail && (!lastOk || lastFail > lastOk) && now.getTime() - lastFail.getTime() < RETRY_BACKOFF_MS) {
    return { skipped: "backoff" };
  }
  if (!shouldFetchFx(now, lastOk)) {
    try {
      await ensurePreviousMonthAverage(now);
    } catch (e) {
      console.error("fx: Monatsmittel fehlgeschlagen", e);
    }
    return { skipped: "not-due" };
  }

  try {
    const result = await refreshExchangeRates(now, fetchImpl);
    if (result.incompleteMonths.length > 0) {
      const month = result.incompleteMonths[0];
      await notifyFailure(
        "Wechselkurse: Monatsmittel unvollstaendig",
        `Fuer ${month} liegen zu wenige EZB-Tageskurse vor (mindestens ${MIN_DAILY_RATES_FOR_MONTH} je Waehrung noetig); es wurde kein Monatsmittel berechnet. Monatskurse bitte manuell pflegen.`,
        `fx-month-incomplete:${month}`,
        now,
      );
    }
    return { fetched: true, ...result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await notifyFailure("Wechselkurs-Abruf fehlgeschlagen", message, `fx-fetch-failed:${now.toISOString().slice(0, 10)}`, now);
    return { error: message };
  }
}
