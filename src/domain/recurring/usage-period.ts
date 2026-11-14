/**
 * Zuordnung eines Verbrauchstags zur Abrechnungsperiode eines Abos (Phase 18f), rein.
 *
 * Perioden sind halboffen `(S_{k-1}, S_k]`; `S_0` ist der naechste Stichtag (`nextRunDate`),
 * die erste offene Periode ist `(S_{-1}, S_0]` mit `S_{-1}` = ein Intervall vor `S_0`
 * (`periodRange`, wie im Lauf). Der Stichtag selbst gehoert zur endenden Periode. Spaetere
 * Stichtage entstehen per `advanceDate` ab `S_0` — genau wie im Lauf (`nextRunDate` wird
 * vom Stichtag aus fortgeschrieben).
 */
import { advanceDate, periodRange, type RecurInterval } from "@/lib/recurring";
import { UsageError } from "./usage-error";

export const MAX_USAGE_PERIOD_STEPS = 400;

export interface UsagePeriodRecurring {
  nextRunDate: Date;
  interval: string;
  intervalCount: number;
  anchorDay: number | null;
  endDate: Date | null;
}

export function resolveUsagePeriod(rec: UsagePeriodRecurring, usageDay: Date): { periodStart: Date; periodEnd: Date } {
  const interval = rec.interval as RecurInterval;
  const first = periodRange(rec.nextRunDate, interval, rec.intervalCount, rec.anchorDay);
  if (usageDay.getTime() <= first.start.getTime()) {
    throw new UsageError("PERIOD_BILLED", "Der Zeitraum ist bereits abgerechnet.");
  }
  let periodStart = first.start;
  let periodEnd = rec.nextRunDate;
  let steps = 0;
  while (usageDay.getTime() > periodEnd.getTime()) {
    if (++steps > MAX_USAGE_PERIOD_STEPS) throw new UsageError("IN_FUTURE", "Der Verbrauchstag liegt zu weit in der Zukunft.");
    periodStart = periodEnd;
    periodEnd = advanceDate(periodEnd, interval, rec.intervalCount, rec.anchorDay);
  }
  if (rec.endDate && periodEnd.getTime() > rec.endDate.getTime()) {
    throw new UsageError("AFTER_END", "Der Verbrauchstag liegt nach dem Ende des Abos.");
  }
  return { periodStart, periodEnd };
}
