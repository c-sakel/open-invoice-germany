/**
 * POST /api/v1/Contact/{id}/vat-check — USt-IdNr. des Kunden ueber VIES pruefen und protokollieren
 * (Phase 17a). Fehler des Dienstes liefern 200 mit status ERROR; abgeschaltet -> 409, Limit -> 429.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeVatIdCheck, vatIdCheckSchema } from "@/api/serializers/vat-check";
import { checkVatId } from "@/domain/customer/vat-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const row = await checkVatId(ctx.orgId, ctx.params.id, { trigger: "MANUAL" });
  return apiData(serializeVatIdCheck(row));
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Contact/{id}/vat-check",
    method: "POST",
    summary: "USt-IdNr. des Kunden qualifiziert ueber VIES pruefen (protokolliert)",
    scope: "write",
    response: apiDataResponseSchema(vatIdCheckSchema),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
