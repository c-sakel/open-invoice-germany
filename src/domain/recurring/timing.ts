/**
 * Abrechnungsart und erster Stichtag eines Abos (Anlage und Änderung teilen denselben Pfad).
 * `validateLeistungsbeginn` läuft immer VOR `firstStichtag`.
 */
import { billingPeriod, firstStichtag, isMonthBased, validateLeistungsbeginn, type BillingTiming, type RecurInterval } from "@/lib/recurring";
import { RecurringError, type TimingChangeDetails } from "@/domain/recurring/errors";

export const USAGE_ADVANCE_MESSAGE = "Verbrauchspositionen werden nachträglich abgerechnet. Abrechnungsart „nachträglich“ wählen.";

/** Verbrauchspositionen vertragen sich nur mit nachträglicher Abrechnung (Verbrauch ist erst danach bekannt). */
export function assertTimingFitsLines(timing: BillingTiming, hasUsageLines: boolean): void {
  if (timing === "ADVANCE" && hasUsageLines) throw new RecurringError(USAGE_ADVANCE_MESSAGE);
}

/**
 * Erster Stichtag und Ankertag aus dem Leistungsbeginn (R7/R8). Ein angegebener Ankertag muss dem
 * berechneten entsprechen (keine Rumpfperiode).
 */
export function resolveFirstSchedule(
  timing: BillingTiming,
  leistungsbeginn: Date,
  interval: RecurInterval,
  count: number,
  givenAnchorDay: number | null | undefined,
): { stichtag: Date; anchorDay: number | null } {
  const problem = validateLeistungsbeginn(timing, leistungsbeginn, interval);
  if (problem !== null) throw new RecurringError(problem);
  const first = firstStichtag(timing, leistungsbeginn, interval, count);
  // Bei täglichem/wöchentlichem Rhythmus gibt es keinen Ankertag: eine Angabe wird ignoriert, nicht abgelehnt.
  if (givenAnchorDay != null && isMonthBased(interval) && givenAnchorDay !== first.anchorDay) {
    throw new RecurringError("Ankertag muss dem Tag des ersten Stichtags entsprechen.");
  }
  return first;
}

const dayNumber = (d: Date): number => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);

/** Lücke/Überlappung zwischen letztem abgerechneten und nächstem Zeitraum (inklusive Grenzen). */
export function timingChangeDetails(
  lastBilled: { start: Date; end: Date } | null,
  next: { timing: BillingTiming; stichtag: Date; interval: RecurInterval; count: number; anchorDay: number | null; endDate: Date | null },
): TimingChangeDetails {
  const p = billingPeriod(next.timing, next.stichtag, next.interval, next.count, next.anchorDay, next.endDate);
  const nextPeriod = { start: p.start, end: p.end };
  if (lastBilled === null) return { lastBilled, nextPeriod, gapDays: 0, overlapDays: 0 };
  const between = dayNumber(nextPeriod.start) - dayNumber(lastBilled.end) - 1;
  return { lastBilled, nextPeriod, gapDays: Math.max(0, between), overlapDays: Math.max(0, -between) };
}
