/**
 * CSV-Download-Antwort (Phase 18b): UTF-8 mit BOM, `nosniff`, `no-store`, `attachment` mit
 * festem ASCII-Dateinamen (nie Nutzertext im Header).
 */
import { NextResponse } from "next/server";
import { CSV_BOM } from "@/domain/export/csv-writer";

const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export function csvResponse(csv: string, filename: string): NextResponse {
  if (!SAFE_FILENAME.test(filename)) throw new Error("Ungueltiger Dateiname");
  return new NextResponse(CSV_BOM + csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
