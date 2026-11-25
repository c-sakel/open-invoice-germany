/**
 * Wiederkehrende Rechnungen — reine Termin-Logik (ohne DB), damit testbar.
 *
 * `advanceDate` schiebt einen Stichtag um ein Intervall weiter. Monatsbasierte
 * Intervalle klemmen den Tag an den Monatsletzten (31.01. + 1 Monat → 28./29.02.),
 * damit nie ein ungültiges Datum entsteht. Optional fixiert `anchorDay` den Tag
 * (z. B. immer der 1.). Gerechnet wird in lokaler Zeit — konsistent mit der
 * Belegnummern-Logik (src/domain/numbering.ts).
 */

import { berlinParts } from "@/lib/berlin-time";

// Phase 8b (§43): DAY ergaenzt WEEKLY/MONTHLY/QUARTERLY/YEARLY um "+intervalCount Tage".
export type RecurInterval = "DAY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

const MONTHS_PER: Record<RecurInterval, number> = {
  DAY: 0,
  WEEKLY: 0,
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
};

export const INTERVAL_LABEL: Record<RecurInterval, string> = {
  DAY: "täglich",
  WEEKLY: "wöchentlich",
  MONTHLY: "monatlich",
  QUARTERLY: "vierteljährlich",
  YEARLY: "jährlich",
};

export function intervalLabel(interval: string, count = 1): string {
  const base = INTERVAL_LABEL[interval as RecurInterval] ?? interval;
  if (count <= 1) return base;
  const unit: Record<RecurInterval, string> = {
    DAY: "Tage",
    WEEKLY: "Wochen",
    MONTHLY: "Monate",
    QUARTERLY: "Quartale",
    YEARLY: "Jahre",
  };
  return `alle ${count} ${unit[interval as RecurInterval] ?? interval}`;
}

/**
 * Normalisiert ein Datum auf 12:00 Uhr lokal seines Kalendertags. Stichtage liegen
 * dadurch nie nahe der Mitternachtsgrenze — so driftet die Tagesanzeige weder über
 * Zeitzonen noch über Sommer-/Winterzeit (toISOString und lokale Formatierung
 * zeigen denselben Kalendertag).
 */
export function normalizeToNoon(d: Date): Date {
  // Berliner Kalendertag des Zeitpunkts (nicht der Serverzeit), danach 12:00 lokal.
  const { year, month, day } = berlinParts(d);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function advanceDate(from: Date, interval: RecurInterval, count = 1, anchorDay?: number | null): Date {
  if (interval === "DAY") {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + count, 12, 0, 0, 0);
  }
  if (interval === "WEEKLY") {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7 * count, 12, 0, 0, 0);
  }
  const months = MONTHS_PER[interval] * count;
  const totalMonth = from.getMonth() + months;
  const targetYear = from.getFullYear() + Math.floor(totalMonth / 12);
  const targetMonth = ((totalMonth % 12) + 12) % 12;
  const desiredDay = anchorDay ?? from.getDate();
  const lastDayOfMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(desiredDay, lastDayOfMonth);
  return new Date(targetYear, targetMonth, day, 12, 0, 0, 0);
}

/**
 * Grenzen der Abrechnungsperiode, die zu einem Periodenstichtag (`periodEnd`) gehört.
 *
 * `periodEnd` ist bei Abos IMMER der Stichtag des aktuellen Laufs (`RecurringInvoice.nextRunDate`
 * zum Zeitpunkt der Erzeugung) — nicht `now`: der Lauf kann nachträglich (z. B. nach einem
 * Ausfall) erzeugt werden, das Leistungsdatum bleibt trotzdem der geplante Stichtag. Der
 * Periodenbeginn ist folgerichtig GENAU ein Intervall VOR diesem Stichtag — `advanceDate` mit
 * negativem `intervalCount` liefert das (dieselbe Monats-/Wochenklemmung wie beim Vorwärts-
 * schieben, siehe `advanceDate`-Kommentar), keine zweite Datumsrechnung.
 *
 * Nur fuer die Verbrauchszuordnung (usage-period.ts, Speichersemantik: Beginn exklusiv).
 * Der Leistungszeitraum eines Belegs (inklusive Grenzen) kommt aus `billingPeriod`.
 */
export function periodRange(
  periodEnd: Date,
  interval: RecurInterval,
  intervalCount: number,
  anchorDay?: number | null,
): { start: Date; end: Date } {
  const start = advanceDate(periodEnd, interval, -intervalCount, anchorDay);
  return { start, end: periodEnd };
}

// ---------------------------------------------------------------------------
// Leistungszeitraum (inklusive Grenzen): im Voraus (ADVANCE) oder nachtraeglich (ARREARS).
// ---------------------------------------------------------------------------

export type BillingTiming = "ADVANCE" | "ARREARS";

export const isMonthBased = (i: RecurInterval): boolean => i === "MONTHLY" || i === "QUARTERLY" || i === "YEARLY";

/** Kalendertage addieren (12:00-normalisiert, zeitzonen- und DST-sicher). */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12, 0, 0, 0);
}

/** Naechster Stichtag nach `stichtag` (= advanceDate, mit Ankertag ohne Drift). */
export function nextStichtag(stichtag: Date, interval: RecurInterval, count: number, anchorDay: number | null): Date {
  return advanceDate(stichtag, interval, count, anchorDay);
}

/**
 * Leistungszeitraum (beide Grenzen inklusive) zum Stichtag `stichtag`.
 * ADVANCE: [S, adv(S) - 1 Tag]; ARREARS: [adv(S, -I) + 1 Tag, S].
 * `endDate` (letzter Leistungstag) kuerzt nur ADVANCE; ARREARS-Laeufe enden mit dem Stichtag.
 * `previousEnd` (Ende des zuletzt abgerechneten Zeitraums) verhindert bei Bestandsabos ohne Ankertag
 * (nachtraeglich, Stichtag nach dem Klemmen am Monatsende, z. B. 31.01. -> 28.02.) eine Doppelabrechnung:
 * der Beginn rueckt hinter das letzte Ende. Luecken werden nie geschlossen.
 */
export function billingPeriod(
  timing: BillingTiming,
  stichtag: Date,
  interval: RecurInterval,
  count: number,
  anchorDay: number | null,
  endDate?: Date | null,
  previousEnd?: Date | null,
): { start: Date; end: Date; clippedByEndDate: boolean } {
  if (timing === "ARREARS") {
    let start = addDays(advanceDate(stichtag, interval, -count, anchorDay), 1);
    if (anchorDay === null && isMonthBased(interval) && previousEnd && start.getTime() <= previousEnd.getTime()) {
      const after = addDays(previousEnd, 1);
      if (after.getTime() <= stichtag.getTime()) start = after;
    }
    return { start, end: stichtag, clippedByEndDate: false };
  }
  const start = stichtag;
  let end = addDays(advanceDate(stichtag, interval, count, anchorDay), -1);
  let clipped = false;
  if (endDate && endDate.getTime() < end.getTime()) {
    end = endDate;
    clipped = true;
  }
  return { start, end, clippedByEndDate: clipped };
}

/**
 * Erster Stichtag und Ankertag eines NEUEN Abos aus dem Leistungsbeginn.
 * ADVANCE: Stichtag = Beginn, Anker = Tag des Beginns. ARREARS: Stichtag = adv(L) - 1 Tag,
 * Anker = Tag dieses Stichtags (Beginn am 1. -> 31 = Monatsletzter). DAY/WEEKLY: kein Anker.
 */
export function firstStichtag(
  timing: BillingTiming,
  leistungsbeginn: Date,
  interval: RecurInterval,
  count: number,
): { stichtag: Date; anchorDay: number | null } {
  const l = new Date(leistungsbeginn.getFullYear(), leistungsbeginn.getMonth(), leistungsbeginn.getDate(), 12, 0, 0, 0);
  const monthBased = isMonthBased(interval);
  if (timing === "ADVANCE") {
    return { stichtag: l, anchorDay: monthBased ? l.getDate() : null };
  }
  const stichtag = addDays(advanceDate(l, interval, count, monthBased ? l.getDate() : null), -1);
  if (!monthBased) return { stichtag, anchorDay: null };
  return { stichtag, anchorDay: l.getDate() === 1 ? 31 : stichtag.getDate() };
}

/** Meldung, wenn der Leistungsbeginn bei nachtraeglicher Abrechnung nicht moeglich ist (R8), sonst null. */
export function validateLeistungsbeginn(timing: BillingTiming, start: Date, interval: RecurInterval): string | null {
  if (timing === "ARREARS" && isMonthBased(interval) && start.getDate() >= 29) {
    return "Bei nachträglicher Abrechnung muss der Leistungsbeginn zwischen dem 1.–28. eines Monats liegen.";
  }
  return null;
}

export type PreviewInput = {
  billingTiming: BillingTiming;
  nextRunDate: Date;
  interval: RecurInterval;
  intervalCount: number;
  anchorDay: number | null;
  endDate: Date | null;
  status: string;
  maxRuns: number | null;
  issuedCount: number;
  /** Ende des zuletzt abgerechneten Zeitraums (nur Bestandsabos ohne Ankertag), sonst weglassen. */
  previousEnd?: Date | null;
};

/** Die naechsten Laeufe mit Leistungszeitraum (Vorschau); beachtet Status, endDate und maxRuns. */
export function previewPeriods(
  rec: PreviewInput,
  n = 6,
): { runDate: Date; start: Date; end: Date; clippedByEndDate: boolean }[] {
  if (rec.status !== "ACTIVE") return [];
  let limit = n;
  if (rec.maxRuns !== null) limit = Math.min(limit, Math.max(0, rec.maxRuns - rec.issuedCount));
  const out: { runDate: Date; start: Date; end: Date; clippedByEndDate: boolean }[] = [];
  let s = rec.nextRunDate;
  let previousEnd = rec.previousEnd ?? null;
  while (out.length < limit) {
    if (rec.endDate && s.getTime() > rec.endDate.getTime()) break;
    const p = billingPeriod(rec.billingTiming, s, rec.interval, rec.intervalCount, rec.anchorDay, rec.endDate, previousEnd);
    out.push({ runDate: s, ...p });
    previousEnd = p.end;
    s = nextStichtag(s, rec.interval, rec.intervalCount, rec.anchorDay);
  }
  return out;
}

/**
 * Nachtraegliche Abrechnung (ARREARS) mit Vertragsende: Der Zeitraum nach dem letzten Stichtag
 * (<= Vertragsende, begrenzt durch maxRuns) wird NICHT abgerechnet. Liefert diesen Rest
 * (erster Tag nach dem letzten Stichtag bis Vertragsende) oder null.
 */
export function unbilledRest(rec: PreviewInput): { start: Date; end: Date } | null {
  if (rec.billingTiming !== "ARREARS" || rec.status !== "ACTIVE" || !rec.endDate) return null;
  const cap = 5000;
  const limit = rec.maxRuns !== null ? Math.max(0, rec.maxRuns - rec.issuedCount) : cap;
  let last: Date | null = null;
  let s = rec.nextRunDate;
  let n = 0;
  while (n < limit && n < cap && s.getTime() <= rec.endDate.getTime()) {
    last = s;
    s = nextStichtag(s, rec.interval, rec.intervalCount, rec.anchorDay);
    n++;
  }
  if (!last || (n >= cap && s.getTime() <= rec.endDate.getTime())) return null;
  const start = addDays(last, 1);
  return start.getTime() <= rec.endDate.getTime() ? { start, end: rec.endDate } : null;
}
