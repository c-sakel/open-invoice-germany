/**
 * POST /api/v1/Invoice/{id}/payLink/refresh — offene Bezahlvorgaenge beim Anbieter abrufen und abgleichen
 * (Buchung ausschliesslich ueber die Zahlungs-Domain; Testmodus bucht nie).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { payLinkRefreshSchema, serializeRefresh } from "@/api/serializers/online-payment";
import { refreshInvoicePayLink } from "@/domain/online-payment/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializeRefresh(await refreshInvoicePayLink(ctx.orgId, ctx.params.id, { createdBy: "api", actor: ctx.actor })));
}, { scope: "write", noIdempotency: true });

export const spec = {
  refresh: {
    path: "/api/v1/Invoice/{id}/payLink/refresh",
    method: "POST",
    summary: "Offene Bezahlvorgaenge der Rechnung abgleichen (bis zu 5 juengste)",
    scope: "write",
    response: apiDataResponseSchema(payLinkRefreshSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
