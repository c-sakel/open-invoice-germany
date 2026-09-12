/**
 * /api/v1/BaseInterestRate — Basiszinssatz-Historie (Phase 14a, Task 4, R6: § 288 Abs. 1
 * Satz 2 BGB). Quelle der Verzugszinsberechnung seit Task 3 (`src/lib/dunning.ts`,
 * `src/domain/dunning/base-rate.ts#loadBaseRates`) — kein Bypass, dieselben Domain-
 * Funktionen wie die Server-Action fuer die Oberflaeche (`src/app/actions/base-interest-
 * rate.ts`). Scope `admin` fuer GET UND POST (dieselbe Regel wie `/api/v1/Settings`,
 * Task-4-Ruling "Scope admin wie Settings").
 *
 * Keine Paginierung: die Historie waechst hoechstens zweimal jaehrlich (01.01./01.07.,
 * Bekanntgabe der Deutschen Bundesbank) — selbst nach Jahrzehnten bleibt die Liste
 * kurz genug fuer eine Antwort ohne `limit`/`offset`.
 */
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeBaseInterestRate, baseInterestRateSchema } from "@/api/serializers/base-interest-rate";
import { listBaseRates, upsertBaseRate } from "@/domain/dunning/base-rate";
import { baseInterestRateInputSchema } from "@/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => {
  const rows = await listBaseRates(ctx.orgId);
  const serialized = rows.map(serializeBaseInterestRate);
  return apiList(serialized, { total: serialized.length, limit: serialized.length, offset: 0 });
}, { scope: "admin" });

export const POST = withApi(async (_req, ctx) => {
  const created = await upsertBaseRate(ctx.orgId, ctx.body);
  return apiData(serializeBaseInterestRate(created), 201);
}, { scope: "admin" });

export const spec = {
  list: {
    path: "/api/v1/BaseInterestRate",
    method: "GET",
    summary: "Basiszinssatz-Historie auflisten (aufsteigend nach 'gueltig ab', keine Paginierung)",
    scope: "admin",
    response: apiListResponseSchema(baseInterestRateSchema),
    errors: [401, 403, 429],
  },
  create: {
    path: "/api/v1/BaseInterestRate",
    method: "POST",
    summary: "Basiszinssatz anlegen oder ueberschreiben (Upsert auf 'gueltig ab')",
    scope: "admin",
    request: { body: baseInterestRateInputSchema },
    response: apiDataResponseSchema(baseInterestRateSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
