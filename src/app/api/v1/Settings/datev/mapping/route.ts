/** /api/v1/Settings/datev/mapping — Kontenzuordnung (Scope admin). PUT ersetzt den gesamten Satz und macht die Bestaetigung hinfaellig. */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { datevMappingRowOutSchema, serializeDatevMappingRow } from "@/api/serializers/datev";
import { listDatevMapping, saveDatevMapping } from "@/domain/export/datev/mapping";
import { datevMappingPutSchema } from "@/schemas/datev";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData((await listDatevMapping(ctx.orgId)).map(serializeDatevMappingRow)), { scope: "admin" });

export const PUT = withApi(async (_req, ctx) => {
  const input = datevMappingPutSchema.parse(ctx.body ?? {});
  return apiData((await saveDatevMapping(ctx.orgId, input.rows, ctx.actor)).map(serializeDatevMappingRow));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/Settings/datev/mapping",
    method: "GET",
    summary: "DATEV-Kontenzuordnung lesen",
    scope: "admin",
    response: apiDataResponseSchema(z.array(datevMappingRowOutSchema)),
    errors: [401, 403, 429],
  },
  update: {
    path: "/api/v1/Settings/datev/mapping",
    method: "PUT",
    summary: "DATEV-Kontenzuordnung ersetzen (gesamter Satz, atomar); macht eine bestehende Bestaetigung hinfaellig",
    scope: "admin",
    request: { body: datevMappingPutSchema },
    response: apiDataResponseSchema(z.array(datevMappingRowOutSchema)),
    errors: [400, 401, 403, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
