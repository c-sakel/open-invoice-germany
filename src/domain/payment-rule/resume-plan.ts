/** Planung der Fortsetzung eines pausierten Abos ohne Nachholen versaeumter Perioden (rein). */
import { advanceDate, type RecurInterval } from "@/lib/recurring";
import { berlinDateKey } from "@/lib/berlin-time";

export const MAX_SKIP_STEPS = 400;

export interface SkipMissedInput {
  nextRunDate: Date;
  interval: RecurInterval;
  intervalCount: number;
  anchorDay: number | null;
  endDate: Date | null;
  now: Date;
  /** Periodenende des aeltesten offenen (nicht abgerechneten, nicht stornierten) Verbrauchs. */
  oldestOpenUsagePeriodEnd: Date | null;
}

export type SkipMissedPlan =
  | { kind: "UNCHANGED" }
  | { kind: "ADVANCE"; nextRunDate: Date; skipped: number }
  | { kind: "BILL_FALLBACK"; reason: string }
  | { kind: "ENDS"; reason: string };

/** Stichtage sind lokale Mittagswerte (normalizeToNoon); verglichen wird der Kalendertag. */
function localKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function planSkipMissed(input: SkipMissedInput): SkipMissedPlan {
  const today = berlinDateKey(input.now);
  if (localKey(input.nextRunDate) >= today) return { kind: "UNCHANGED" };
  let cur = input.nextRunDate;
  let skipped = 0;
  while (localKey(cur) < today) {
    if (skipped >= MAX_SKIP_STEPS) return { kind: "BILL_FALLBACK", reason: "Zu viele versaeumte Perioden, Rueckstand wird abgerechnet." };
    cur = advanceDate(cur, input.interval, input.intervalCount, input.anchorDay);
    skipped += 1;
  }
  if (input.endDate && cur.getTime() > input.endDate.getTime()) {
    return { kind: "ENDS", reason: "Das Enddatum liegt im uebersprungenen Zeitraum, das Abo bleibt pausiert." };
  }
  if (input.oldestOpenUsagePeriodEnd && localKey(input.oldestOpenUsagePeriodEnd) < localKey(cur)) {
    return { kind: "BILL_FALLBACK", reason: "Offener Verbrauch in uebersprungenen Perioden, Rueckstand wird abgerechnet." };
  }
  return { kind: "ADVANCE", nextRunDate: cur, skipped };
}
