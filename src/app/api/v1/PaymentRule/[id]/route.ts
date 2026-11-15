/** GET (read), PATCH und DELETE = archivieren (admin) einer Regel nach Zahlungseingang. */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializePaymentRule } from "@/api/serializers/payment-rule";
import { archivePaymentRule, getPaymentRule, updatePaymentRule } from "@/domain/payment-rule/rules";
import { paymentRuleUpdateSchema } from "@/schemas/payment-rule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializePaymentRule(await getPaymentRule(ctx.orgId, ctx.params.id)));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializePaymentRule(await updatePaymentRule(ctx.orgId, ctx.params.id, ctx.body, ctx.actor)));
}, { scope: "admin" });

export const DELETE = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializePaymentRule(await archivePaymentRule(ctx.orgId, ctx.params.id, ctx.actor)));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/PaymentRule/{id}",
    method: "GET",
    summary: "Regel nach Zahlungseingang abrufen",
    scope: "read",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/PaymentRule/{id}",
    method: "PATCH",
    summary: "Regel nach Zahlungseingang aendern (nur uebergebene Felder; archivierte Regeln nicht)",
    scope: "admin",
    request: { body: paymentRuleUpdateSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 404, 422, 429],
  },
  archive: {
    path: "/api/v1/PaymentRule/{id}",
    method: "DELETE",
    summary: "Regel archivieren (nie hart geloescht; bereits erzeugte Laeufe bleiben erhalten)",
    scope: "admin",
    response: apiDataResponseSchema(z.unknown()),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
