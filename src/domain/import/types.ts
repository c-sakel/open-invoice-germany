/**
 * Gemeinsame Typen und Hilfen der Stammdaten-Importe (Phase 18b). Rein, ohne Datenbankzugriff.
 * Fehlermeldungen enthalten nie Zellwerte (nur Zeile, Spalte, Text).
 */
import type { z } from "zod";
import { stripFormulaGuard } from "@/domain/export/csv-writer";
import type { ImportColumn } from "./columns";

export interface ParsedRow {
  line: number;
  cells: string[];
}
export interface ImportRowError {
  line: number;
  column: string | null;
  message: string;
}
export interface RowProblem {
  column: string;
  message: string;
}
export type ColumnIndex = Map<string, number>;

/** Zelle -> getrimmter Text ohne Formelschutz-Apostroph; leer -> undefined. */
export function cellValue(cells: readonly string[], index: ColumnIndex, key: string): string | undefined {
  const i = index.get(key);
  if (i === undefined) return undefined;
  const v = stripFormulaGuard((cells[i] ?? "").trim()).trim();
  return v === "" ? undefined : v;
}

export function headerOf(columns: readonly ImportColumn[], key: string): string {
  return columns.find((c) => c.key === key)?.header ?? key;
}

/** Zod-Issues -> deutsche Meldungen je Import-Spalte. `keyMap` ordnet Schemafelder den Spaltenschluesseln zu. */
export function zodProblems(
  error: z.ZodError,
  columns: readonly ImportColumn[],
  keyMap: Readonly<Record<string, string>>,
  lengthTwoFields: readonly string[] = [],
  input: Readonly<Record<string, unknown>> = {},
): RowProblem[] {
  const out: RowProblem[] = [];
  for (const issue of error.issues) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : "";
    const column = headerOf(columns, keyMap[field] ?? field);
    let message: string;
    if (lengthTwoFields.includes(field) && (issue.code === "too_small" || issue.code === "too_big")) message = "Ländercode mit zwei Buchstaben";
    else if (issue.code === "invalid_type" && input[field] === undefined) message = "Pflichtfeld fehlt";
    else if (issue.code === "invalid_type") message = "Ungültiger Wert";
    else if (issue.code === "too_small") {
      const min = Number(issue.minimum);
      if (issue.origin === "string") message = min <= 1 ? "Pflichtfeld fehlt" : `Mindestens ${min} Zeichen erwartet`;
      else message = min === 0 ? "Darf nicht negativ sein" : `Wert unter dem Mindestwert ${min}`;
    } else if (issue.code === "too_big") {
      const max = Number(issue.maximum);
      message = issue.origin === "string" ? `Höchstens ${max} Zeichen erlaubt` : `Wert über dem Höchstwert ${max}`;
    }
    else if (issue.code === "invalid_format" && issue.format === "email") message = "Ungültige E-Mail-Adresse";
    else if (issue.code === "custom") message = issue.message;
    else message = "Ungültiger Wert";
    out.push({ column, message });
  }
  return out;
}

/** Steuerzeichen (C0/C1 ausser Tab, LF, CR; DEL) und NUL: nie in Stammdaten (Postgres lehnt NUL ab). */
export const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** Zeilenfehler fuer Steuerzeichen in den zugeordneten Zellen (ohne Zellwert in der Meldung). */
export function controlCharProblems(cells: readonly string[], index: ColumnIndex, columns: readonly ImportColumn[]): RowProblem[] {
  const out: RowProblem[] = [];
  for (const col of columns) {
    const i = index.get(col.key);
    if (i !== undefined && CONTROL_CHARS.test(cells[i] ?? "")) out.push({ column: col.header, message: "Enthält unzulässige Steuerzeichen" });
  }
  return out;
}

/** Kopfname aus der Nutzerdatei fuer Antworten kuerzen (nur die ersten 80 Zeichen). */
export function clipHeaderName(name: string): string {
  const chars = Array.from(name);
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : name;
}

const UNSAFE_FILENAME_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/u;

/** Nutzer-Dateiname fuers Protokoll: ohne Steuer-/Format-/Bidi-Zeichen (Cc, Cf, Zl, Zp), `/`, `\`, max. 120 Zeichen. */
export function sanitizeFileName(name: string | undefined): string | null {
  if (!name) return null;
  let out = "";
  let n = 0;
  for (const ch of name) {
    if (UNSAFE_FILENAME_CHAR.test(ch)) continue;
    out += ch;
    if (++n >= 120) break;
  }
  out = out.trim();
  return out === "" ? null : out;
}
