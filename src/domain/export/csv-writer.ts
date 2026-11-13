/**
 * Gemeinsamer, reiner CSV-Schreiber (Phase 18b, Task 1; Kern aus 17c `reporting/csv.ts`):
 * Semikolon, CRLF, deutsche Zahlen, ohne BOM (den BOM setzt der Aufrufer ueber `CSV_BOM`).
 * Jede Textzelle und jede Kopfzelle laeuft durch `csvTextCell` (Formelschutz gegen
 * Tabellenkalkulations-Injection). Geld nur aus Integer-Cent, nie per Float.
 *
 * Der Prueferexport (`src/domain/audit/export-csv.ts`) bleibt bewusst unveraendert:
 * GoBD, Rohdaten ohne Entschaerfung.
 */
import { formatCentsDe, formatDateDe, formatMilliDe } from "@/domain/audit/export-csv";
import { berlinParts } from "@/lib/berlin-time";

export const CSV_BOM = "﻿";

/** Fuehrende Leerraeume und unsichtbare Zeichen (Zero-Width, BOM, NBSP, NUL), die Tabellenkalkulationen ueberspringen. */
const FORMULA_START = /^[\s\u0000\u00a0\u200b\u200c\u200d\u2060\ufeff　]*[=+\-@\t\r＝＋－＠]/;

/** Textzelle: Formelzeichen am Anfang mit `'` entschaerfen, bei Trennzeichen/Anfuehrung/Umbruch quoten. */
export function csvTextCell(v: string | null): string {
  if (v === null) return "";
  let s = v;
  // Formelschutz (OWASP CSV Injection): auch nach fuehrendem Leerraum und fuer Vollbreite-Varianten.
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[;"\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Rueckweg fuer den Import: entfernt ein fuehrendes `'` nur, wenn danach ein Formelzeichen
 * nach derselben Regel folgt (`'=A1` -> `=A1`, `'abc` und `'` bleiben).
 */
export function stripFormulaGuard(v: string): string {
  if (v.startsWith("'") && FORMULA_START.test(v.slice(1))) return v.slice(1);
  return v;
}

export type CsvKind = "text" | "int" | "cents" | "milli" | "tenths" | "permille" | "date" | "berlinDate" | "bool";

export interface CsvColumn<R> {
  header: string;
  kind: CsvKind;
  get: (r: R) => string | number | boolean | Date | null;
}

export const col = <R>(header: string, kind: CsvKind, get: CsvColumn<R>["get"]): CsvColumn<R> => ({ header, kind, get });

/** Zehntel/Promille-Wert (bereits auf Integer gerundet) als `12,3`. */
function formatTenths(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.trunc(abs / 10)},${abs % 10}`;
}

/** Zeitpunkt -> `TT.MM.JJJJ` des Berliner Kalendertags. */
export function formatBerlinDateDe(d: Date): string {
  const p = berlinParts(d);
  return `${String(p.day).padStart(2, "0")}.${String(p.month).padStart(2, "0")}.${p.year}`;
}

function cell(kind: CsvKind, v: string | number | boolean | Date | null): string {
  if (v === null) return "";
  switch (kind) {
    case "text":
      return csvTextCell(String(v));
    case "bool":
      return v ? "ja" : "nein";
    case "date":
      return v instanceof Date ? formatDateDe(v) : "";
    case "berlinDate":
      return v instanceof Date ? formatBerlinDateDe(v) : "";
    case "int":
      return String(Number(v));
    case "cents":
      return formatCentsDe(Number(v));
    case "milli":
      return formatMilliDe(Number(v));
    case "tenths":
    case "permille":
      return formatTenths(Number(v));
  }
}

/** Kopf (durch `csvTextCell`), CRLF, Abschluss-CRLF. */
export function csvTable<R>(columns: readonly CsvColumn<R>[], rows: readonly R[]): string {
  const lines = [columns.map((c) => csvTextCell(c.header)).join(";")];
  for (const r of rows) lines.push(columns.map((c) => cell(c.kind, c.get(r))).join(";"));
  return lines.join("\r\n") + "\r\n";
}
