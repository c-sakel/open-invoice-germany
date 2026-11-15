/** GET /api/v1/DatevExport/status — Bestaetigungsstand, exportierte Monate und Nachtraege (Scope admin). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { datevStatusSchema, serializeDatevStatus } from "@/api/serializers/datev";
import { datevStatus } from "@/domain/export/datev/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(serializeDatevStatus(await datevStatus(ctx.orgId, new Date()))), { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/DatevExport/status",
    method: "GET",
    summary: "DATEV-Status: Bestaetigung, exportierte Monate, Nachtraege in bereits exportierten Monaten",
    scope: "admin",
    response: apiDataResponseSchema(datevStatusSchema),
    errors: [401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
