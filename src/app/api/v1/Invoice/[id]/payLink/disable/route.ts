/**
 * POST /api/v1/Invoice/{id}/payLink/disable — Bezahllink deaktivieren (reaktivierbar ueber POST payLink).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { payLinkSchema, serializePayLink } from "@/api/serializers/online-payment";
import { disableInvoicePayLink } from "@/domain/online-payment/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializePayLink(await disableInvoicePayLink(ctx.orgId, ctx.params.id, ctx.actor)));
}, { scope: "write", noIdempotency: true });

export const spec = {
  disable: {
    path: "/api/v1/Invoice/{id}/payLink/disable",
    method: "POST",
    summary: "Bezahllink deaktivieren",
    scope: "write",
    response: apiDataResponseSchema(payLinkSchema),
    errors: [401, 403, 404, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
