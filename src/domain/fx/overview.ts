/**
 * Lesezugriffe fuer die Kursseite (Einstellungen -> Kurse, Phase 16b, Task 9): die zuletzt
 * gespeicherten Kurse (optional je Waehrung) und der Zeitpunkt des letzten erfolgreichen Abrufs.
 * "Letzter Abruf" stammt wie im Scheduler-Job aus dem Laufprotokoll (`fetched: true`), nicht aus
 * `ExchangeRate.fetchedAt`: an Wochenenden bringt die EZB keine neuen Zeilen.
 */
import { dbInternal } from "@/lib/db";
import type { ExchangeRateRow } from "./store";

export const FX_OVERVIEW_LIMIT = 200;

export async function listExchangeRates(filter: { currency?: string; limit?: number } = {}): Promise<ExchangeRateRow[]> {
  return dbInternal.exchangeRate.findMany({
    where: filter.currency ? { currency: filter.currency } : {},
    orderBy: [{ rateDate: "desc" }, { currency: "asc" }, { source: "asc" }],
    take: Math.min(filter.limit ?? FX_OVERVIEW_LIMIT, FX_OVERVIEW_LIMIT),
    select: { id: true, source: true, currency: true, rateDate: true, rateMicros: true, origin: true, note: true, fetchedAt: true },
  });
}

export async function lastFxFetchAt(): Promise<Date | null> {
  const run = await dbInternal.schedulerRun.findFirst({
    where: { job: "fx", status: "OK", summaryJson: { contains: '"fetched":true' } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  return run?.startedAt ?? null;
}
