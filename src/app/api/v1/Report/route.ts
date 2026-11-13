/**
 * /api/v1/Report — Auswertungen (Phase 12e, Task 5). Rein lesend: liefert dieselben vier
 * Report-Typen wie Dashboard und Kundenseite (`revenue`, `top-customers`, `status`,
 * `payment-behaviour`), gebündelt über `runReport` (src/domain/reporting/query.ts) — kein
 * zweiter Aggregationscode für die API (§1.4). `Report` ist KEINE CRUD-Ressource (kein
 * Eintrag in `RESOURCE_SCHEMAS` nötig — die Überschreibung dort greift nur für Basis-CRUD-
 * Pfade mit eigenem Serialisierer, siehe src/api/openapi.ts): `apiDataResponseSchema
 * (z.unknown())` genügt, wie bei den Aktions-Endpunkten.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { NextResponse } from "next/server";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { runReport, reportQuerySchema } from "@/domain/reporting/query";
import { CSV_BOM, reportCsvFilename, reportToCsv } from "@/domain/reporting/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const raw = Object.fromEntries(searchParams);
  const now = new Date();
  const result = await runReport(ctx.orgId, raw, now);
  // `runReport` hat `format` bereits validiert (nur json | csv, sonst ZodError -> 400).
  if (raw.format === "csv") {
    return new NextResponse(CSV_BOM + reportToCsv(result), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${reportCsvFilename(result.type, now)}"`,
        "cache-control": "no-store",
      },
    });
  }
  return apiData(result);
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/Report",
    method: "GET",
    summary: "Auswertung abrufen (revenue | top-customers | status | payment-behaviour | cash-in | quote-outcome | top-products | recurring-run-rate); format=csv liefert text/csv",
    scope: "read",
    request: { query: reportQuerySchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
