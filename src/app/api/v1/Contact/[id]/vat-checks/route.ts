/**
 * GET /api/v1/Contact/{id}/vat-checks — Pruefprotokoll der USt-IdNr. (neueste zuerst, max. 50).
 */
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeVatIdCheck, vatIdCheckSchema } from "@/api/serializers/vat-check";
import { listVatIdChecks } from "@/domain/customer/vat-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const rows = await listVatIdChecks(ctx.orgId, ctx.params.id, 50);
  return apiList(rows.map(serializeVatIdCheck), { total: rows.length, limit: 50, offset: 0 });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/Contact/{id}/vat-checks",
    method: "GET",
    summary: "Pruefprotokoll der USt-IdNr. eines Kunden (max. 50, neueste zuerst)",
    scope: "read",
    response: apiListResponseSchema(vatIdCheckSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
