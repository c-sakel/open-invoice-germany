/**
 * Abrufzeitraum, Freigabe-Fristen und Zeitplan des Kontoabrufs (rein, ohne Datenbank). Alle Tage sind Berliner
 * Kalendertage im Format YYYY-MM-DD.
 */
import { berlinDateKey, berlinParts, berlinWallTime } from "@/lib/berlin-time";
import { FETCH_FIRST_DAYS_DEFAULT, FETCH_MAX_DAYS_AUTO, FETCH_MAX_DAYS_MANUAL, FETCH_OVERLAP_DAYS } from "./limits";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Spaetestens dann braucht die Bank wieder eine starke Freigabe (180 Tage nach der letzten). */
export const SCA_VALID_DAYS = 180;
/** Ab diesem Tag nach der letzten Freigabe wird auf die baldige Erneuerung hingewiesen. */
export const SCA_WARN_DAYS = 170;

/** Berliner Kalendertag des Zeitpunkts. */
export function berlinToday(now: Date): string {
  return berlinDateKey(now);
}

function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}

function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return fromDayNumber(dayNumber(day) + days);
}

export interface FetchWindowInput {
  today: string;
  lastFetchedTo: string | null;
  firstFetchDays: number;
  mode: "AUTO" | "MANUAL";
  manualFrom?: string | undefined;
  /** Wie weit die Bank Umsaetze zurueck liefert (sofern bekannt). */
  maxHistoryDays: number | null;
}

export interface FetchWindow {
  from: string;
  to: string;
  /** Gewuenschter Beginn, wenn der Zeitraum gekuerzt wurde: davor liegende Tage wurden nicht abgerufen (Luecke). */
  gapBefore: string | null;
}

/**
 * Automatisch: ab 7 Tage vor dem letzten Abruf (erster Abruf: Standardtage), hoechstens 89 Tage zurueck (ohne starke
 * Freigabe). Manuell mit Startdatum: hoechstens 365 Tage, nie weiter als die Bank liefert. Das Ende ist immer heute.
 */
export function fetchWindow(a: FetchWindowInput): FetchWindow {
  const to = a.today;
  let wanted: string;
  if (a.mode === "MANUAL" && a.manualFrom !== undefined) wanted = a.manualFrom;
  else if (a.lastFetchedTo !== null) wanted = addDays(a.lastFetchedTo, -FETCH_OVERLAP_DAYS);
  else wanted = addDays(to, -(a.firstFetchDays > 0 ? a.firstFetchDays : FETCH_FIRST_DAYS_DEFAULT));
  if (wanted > to) wanted = to;
  const policy = a.mode === "MANUAL" && a.manualFrom !== undefined ? FETCH_MAX_DAYS_MANUAL : FETCH_MAX_DAYS_AUTO;
  const limit = a.maxHistoryDays !== null && a.maxHistoryDays > 0 ? Math.min(policy, a.maxHistoryDays) : policy;
  const earliest = addDays(to, -limit);
  if (wanted < earliest) return { from: earliest, to, gapBefore: wanted };
  return { from: wanted, to, gapBefore: null };
}

export function scaRenewBy(lastScaAt: Date | null): Date | null {
  return lastScaAt ? new Date(lastScaAt.getTime() + SCA_VALID_DAYS * DAY_MS) : null;
}

/** Ab Tag 170 nach der letzten Freigabe (Berliner Kalendertage). */
export function scaWarnDue(lastScaAt: Date | null, now: Date): boolean {
  if (!lastScaAt) return false;
  return dayNumber(berlinToday(now)) - dayNumber(berlinToday(lastScaAt)) >= SCA_WARN_DAYS;
}

/** Naechster Berliner Tag um `autoHour` Uhr Wandzeit (auch an Tagen der Zeitumstellung). */
export function nextAutoAt(now: Date, autoHour: number): Date {
  const { year, month, day } = berlinParts(now);
  return berlinWallTime(year, month, day + 1, autoHour);
}

/** Heute um `autoHour` Uhr, sofern das noch bevorsteht, sonst morgen (Wandzeit). */
export function nextAutoAtFromToday(now: Date, autoHour: number): Date {
  const { year, month, day } = berlinParts(now);
  const today = berlinWallTime(year, month, day, autoHour);
  return today.getTime() > now.getTime() ? today : berlinWallTime(year, month, day + 1, autoHour);
}
