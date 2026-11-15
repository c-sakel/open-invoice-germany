/** GET /api/v1/DatevExport/{id} — Protokoll eines Laufs inklusive Posten (seitenweise, Scope admin). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { datevExportDetailSchema, serializeDatevExport, serializeDatevItem } from "@/api/serializers/datev";
import { getDatevExport, listDatevExportItems } from "@/domain/export/datev/run";
import { datevItemsQuerySchema } from "@/schemas/datev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (req, ctx) => {
  const q = datevItemsQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  const view = await getDatevExport(ctx.orgId, ctx.params.id);
  const { total, items } = await listDatevExportItems(ctx.orgId, ctx.params.id, q);
  return apiData({ ...serializeDatevExport(view), items: items.map(serializeDatevItem), itemTotal: total, itemLimit: q.limit, itemOffset: q.offset });
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/DatevExport/{id}",
    method: "GET",
    summary: "Protokoll eines DATEV-Exports mit Posten (seitenweise: limit bis 1000, offset)",
    scope: "admin",
    request: { query: datevItemsQuerySchema },
    response: apiDataResponseSchema(datevExportDetailSchema),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
