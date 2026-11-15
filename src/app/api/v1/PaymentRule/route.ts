/**
 * /api/v1/PaymentRule — Regeln nach Zahlungseingang. Lesen (read); Anlegen/Aendern/Archivieren/Trockenlauf (admin):
 * eine Regel kann Mails, Webhooks und Abo-Fortsetzungen ausloesen, daher wie Webhook/Settings eine Konfiguration.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { paymentRuleSchema, serializePaymentRule } from "@/api/serializers/payment-rule";
import { createPaymentRule, listPaymentRules } from "@/domain/payment-rule/rules";
import { paymentRuleInputSchema } from "@/schemas/payment-rule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuerySchema = z.object({ includeArchived: z.enum(["true", "false", "1", "0"]).optional() });

export const GET = withApi(async (req, ctx) => {
  const raw = new URL(req.url).searchParams.get("includeArchived");
  const q = listQuerySchema.parse(raw === null ? {} : { includeArchived: raw });
  const rows = await listPaymentRules(ctx.orgId, { includeArchived: q.includeArchived === "true" || q.includeArchived === "1" });
  return apiList(rows.map(serializePaymentRule), { total: rows.length, limit: rows.length, offset: 0 });
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const created = await createPaymentRule(ctx.orgId, ctx.body, ctx.actor);
  return apiData(serializePaymentRule(created), 201);
}, { scope: "admin" });

export const spec = {
  list: {
    path: "/api/v1/PaymentRule",
    method: "GET",
    summary: "Regeln nach Zahlungseingang auflisten (archivierte nur mit includeArchived=true)",
    scope: "read",
    request: { query: listQuerySchema },
    response: apiListResponseSchema(paymentRuleSchema),
    errors: [400, 401, 403, 429],
  },
  create: {
    path: "/api/v1/PaymentRule",
    method: "POST",
    summary: "Regel nach Zahlungseingang anlegen (hoechstens 20 aktive je Organisation)",
    scope: "admin",
    request: { body: paymentRuleInputSchema },
    response: apiDataResponseSchema(paymentRuleSchema),
    errors: [400, 401, 403, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
