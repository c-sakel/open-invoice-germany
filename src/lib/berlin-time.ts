/**
 * Berliner Kalendergrenzen (Europe/Berlin) ohne Zusatzabhaengigkeit, ueber Intl.
 * Einzige Quelle fuer Monats-, Jahres- und Tagesgrenzen der Auswertungen, des OSS-Jahres
 * und des Skonto-Fristendes.
 *
 * Abgrenzung zu src/lib/date-only.ts: reine Kalenderdaten (Faelligkeit, Gueltigkeit,
 * Mahnwesen) werden weiter als UTC-Mitternacht gespeichert und tagesgenau im UTC-Kalendertag
 * verglichen. Hier geht es nur um Zeitpunkte (Zahlungseingang, Belegzeitpunkt), die einem
 * Berliner Kalendertag zugeordnet werden. UTC-Mitternachtswerte (date-only) liegen immer im
 * selben Berliner Kalendertag (01:00/02:00 Uhr Ortszeit).
 */
export const BERLIN_TZ = "Europe/Berlin";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BERLIN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function partsOf(d: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter.formatToParts(d)) {
    if (p.type === "year" || p.type === "month" || p.type === "day" || p.type === "hour" || p.type === "minute" || p.type === "second") {
      out[p.type] = Number(p.value);
    }
  }
  return out;
}

/** Berliner Kalendertag eines Zeitpunkts (month 1..12). */
export function berlinParts(d: Date): { year: number; month: number; day: number } {
  const { year, month, day } = partsOf(d);
  return { year, month, day };
}

/** Berliner Wandzeit eines Instants als "UTC-Millisekunden" (Offset-Vergleich). */
function localMs(t: number): number {
  const p = partsOf(new Date(t));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** 00:00 Uhr Berliner Zeit des Tages als UTC-Instant; Ueberlauf (month 13, day 0) wird normalisiert. */
export function berlinMidnight(year: number, month: number, day: number): Date {
  const wall = Date.UTC(year, month - 1, day);
  // Berlin liegt bei +1 h (MEZ) bzw. +2 h (MESZ) vor UTC; die Umstellung faellt nie auf Mitternacht.
  for (const offsetHours of [1, 2]) {
    const t = wall - offsetHours * 3_600_000;
    if (localMs(t) === wall) return new Date(t);
  }
  return new Date(wall - 3_600_000);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Berliner Kalendermonat als "YYYY-MM". */
export function berlinMonthKey(d: Date): string {
  const { year, month } = berlinParts(d);
  return `${year}-${pad2(month)}`;
}

/** Monatserster 00:00 Berliner Zeit (optional um ganze Monate verschoben). */
export function berlinMonthStart(d: Date, offsetMonths = 0): Date {
  const { year, month } = berlinParts(d);
  return berlinMidnight(year, month + offsetMonths, 1);
}

/** Berliner Kalenderjahr eines Zeitpunkts. */
export function berlinYear(d: Date): number {
  return berlinParts(d).year;
}

/** 1. Januar 00:00 Berliner Zeit. */
export function berlinYearStart(year: number): Date {
  return berlinMidnight(year, 1, 1);
}

/** Letzte Millisekunde des Berliner Tages; Kalendertag = UTC-Datum von `calendarDate` (date-only-Konvention). */
export function berlinDayEnd(calendarDate: Date): Date {
  const next = berlinMidnight(calendarDate.getUTCFullYear(), calendarDate.getUTCMonth() + 1, calendarDate.getUTCDate() + 1);
  return new Date(next.getTime() - 1);
}

/** Berliner Kalendertag als "YYYY-MM-DD". */
export function berlinDateKey(d: Date): string {
  const { year, month, day } = berlinParts(d);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}
