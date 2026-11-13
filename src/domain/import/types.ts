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
): RowProblem[] {
  const out: RowProblem[] = [];
  for (const issue of error.issues) {
    const field = typeof issue.path[0] === "string" ? issue.path[0] : "";
    const column = headerOf(columns, keyMap[field] ?? field);
    let message: string;
    if (lengthTwoFields.includes(field) && (issue.code === "too_small" || issue.code === "too_big")) message = "Ländercode mit zwei Buchstaben";
    else if (issue.code === "invalid_type" && String(issue.message).toLowerCase().includes("undefined")) message = "Pflichtfeld fehlt";
    else if (issue.code === "too_small") message = "Pflichtfeld fehlt";
    else if (issue.code === "invalid_format" && issue.format === "email") message = "Ungültige E-Mail-Adresse";
    else if (issue.code === "custom") message = issue.message;
    else message = "Ungültiger Wert";
    out.push({ column, message });
  }
  return out;
}

/** Nutzer-Dateiname fuers Protokoll: keine Steuerzeichen, `/`, `\`, max. 120 Zeichen. */
export function sanitizeFileName(name: string | undefined): string | null {
  if (!name) return null;
  let out = "";
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 32 || c === 127 || ch === "/" || ch === "\\") continue;
    out += ch;
    if (out.length >= 120) break;
  }
  out = out.trim();
  return out === "" ? null : out;
}
