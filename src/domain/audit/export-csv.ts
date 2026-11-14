/**
 * CSV-Bausteine des Pruefer-Exports (Phase 16a): Semikolon, CRLF, deutsche Zahlen- und
 * Datumsformate (GDPdU/Beschreibungsstandard: Dezimalzeichen `,`, Tausenderzeichen keines).
 */
export type CsvValue = string | number | null;

/** Spaltentyp fuer die Beschreibung in `index.xml`. */
export type CsvColumnType = "text" | "int" | "amount" | "amount5" | "quantity" | "date" | "datetime";

export interface CsvColumn {
  name: string;
  type: CsvColumnType;
}

export function csvField(v: CsvValue): string {
  if (v === null) return "";
  const s = String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(values: CsvValue[]): string {
  return values.map(csvField).join(";") + "\r\n";
}

/** Cent als deutsche Dezimalzahl: `-1234` -> `-12,34`, `5` -> `0,05`. */
export function formatCentsDe(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Milli-Cent (tausendstel Cent) als deutsche Dezimalzahl in EUR mit fuenf Nachkommastellen
 * (`200` -> `0,00200`). Reine Ganzzahl-/Stringarithmetik, kein Float.
 */
export function formatMilliCentsDe(milliCents: number): string {
  const sign = milliCents < 0 ? "-" : "";
  const abs = String(Math.abs(milliCents)).padStart(6, "0");
  return `${sign}${abs.slice(0, -5)},${abs.slice(-5)}`;
}

/** Milli-Einheiten als deutsche Dezimalzahl mit drei Nachkommastellen (`1500` -> `1,500`). */
export function formatMilliDe(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(milli);
  return `${sign}${Math.trunc(abs / 1000)},${String(abs % 1000).padStart(3, "0")}`;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `TT.MM.JJJJ` in UTC. */
export function formatDateDe(d: Date): string {
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** `TT.MM.JJJJ HH:MM:SS` in UTC. */
export function formatDateTimeDe(d: Date): string {
  return `${formatDateDe(d)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

export function csvHeader(columns: readonly CsvColumn[]): string {
  return csvRow(columns.map((c) => c.name));
}
