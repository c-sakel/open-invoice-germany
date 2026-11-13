/**
 * `?format=csv` der REST-Listen (Phase 18b, Task 3). `format` wird zuerst validiert (nur json | csv,
 * sonst ZodError -> 400); bei `csv` liefert der Export dieselbe Id-Menge/Sortierung wie die Liste,
 * ohne Paginierung (Obergrenze `EXPORT_ROW_LIMIT`, sonst 413). Ohne `format=csv` -> `null` (JSON-Pfad).
 */
import { z } from "zod";
import type { NextResponse } from "next/server";
import { csvFormatQuery, exportFromApiFilter, type ExportResource } from "@/domain/export";
import { csvResponse } from "@/lib/http/csv-response";

const formatSchema = z.object(csvFormatQuery);

/** Query-Schluessel, die fuer die CSV-Datei entfallen (Paginierung, Einbettungen, Format). */
const DROPPED_KEYS = ["format", "embed", "limit", "offset"] as const;

export async function csvListResponse(
  orgId: string,
  resource: ExportResource,
  searchParams: URLSearchParams,
  prepare: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw,
): Promise<NextResponse | null> {
  const { format } = formatSchema.parse({ format: searchParams.get("format") ?? undefined });
  if (format !== "csv") return null;
  const raw: Record<string, unknown> = Object.fromEntries(searchParams);
  for (const k of DROPPED_KEYS) delete raw[k];
  const result = await exportFromApiFilter(orgId, resource, prepare(raw));
  return csvResponse(result.csv, result.filename);
}
