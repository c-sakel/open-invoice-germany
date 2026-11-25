/**
 * Bundeseinheitliche gesetzliche Feiertage (Neujahr, Karfreitag, Ostermontag, 1. Mai, Christi Himmelfahrt,
 * Pfingstmontag, Tag der Deutschen Einheit, 1./2. Weihnachtstag). Landesfeiertage sind bewusst nicht enthalten.
 * Alle Tage sind Kalendertage als UTC-Mitternacht.
 */
const DAY_MS = 86_400_000;

/** Ostersonntag (Gregorianisch, anonymer Algorithmus nach Meeus/Jones/Butcher). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const dayOfMonth = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, dayOfMonth));
}

export function isNationalHoliday(day: Date): boolean {
  const y = day.getUTCFullYear();
  const t = Date.UTC(y, day.getUTCMonth(), day.getUTCDate());
  const fixed = [
    Date.UTC(y, 0, 1),
    Date.UTC(y, 4, 1),
    Date.UTC(y, 9, 3),
    Date.UTC(y, 11, 25),
    Date.UTC(y, 11, 26),
  ];
  if (fixed.includes(t)) return true;
  const easter = easterSunday(y).getTime();
  return [-2, 1, 39, 50].some((offset) => easter + offset * DAY_MS === t);
}

/** Samstag, Sonntag oder bundeseinheitlicher Feiertag. */
export function isNonBusinessDay(day: Date): boolean {
  const dow = day.getUTCDay();
  return dow === 0 || dow === 6 || isNationalHoliday(day);
}

/** § 193 BGB: fällt der Tag auf Sa/So/Feiertag, gilt der nächste Werktag. */
export function nextBusinessDay(day: Date): Date {
  let d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  while (isNonBusinessDay(d)) d = new Date(d.getTime() + DAY_MS);
  return d;
}
