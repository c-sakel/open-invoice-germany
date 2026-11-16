/** POST /api/v1/IncomingInvoice/{id}/validate — Prüfung gegen EN 16931/XRechnung erneut ausführen (neue, unveränderliche Ergebniszeile). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { incomingValidateResultSchema, serializeValidateResult } from "@/api/serializers/incoming";
import { withIncomingErrors } from "@/api/incoming-errors";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { requestIncomingValidation } from "@/domain/incoming/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) =>
  withIncomingErrors(async () => {
    const r = await requestIncomingValidation(ctx.orgId, ctx.params.id);
    return apiData(serializeValidateResult(r, await getIncomingInvoiceDetail(ctx.orgId, ctx.params.id, { ibanMode: "masked", maxLines: 0 })));
  }), { scope: "write" });

export const spec = {
  validate: {
    path: "/api/v1/IncomingInvoice/{id}/validate",
    method: "POST",
    summary: "Eingangsrechnung erneut prüfen (höchstens 10 je Minute)",
    scope: "write",
    response: apiDataResponseSchema(incomingValidateResultSchema),
    errors: [401, 403, 404, 429, 500, 503],
  },
} satisfies Record<string, RouteSpec>;
