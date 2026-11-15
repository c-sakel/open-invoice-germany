/** POST (admin): einen fehlgeschlagenen Lauf wiederholen (nur der fehlgeschlagene Schritt wird erneut versucht). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { paymentRuleRunSchema, serializePaymentRuleRun } from "@/api/serializers/payment-rule";
import { retryPaymentRuleRun } from "@/domain/payment-rule/execute";
import { getPaymentRuleRun } from "@/domain/payment-rule/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  await retryPaymentRuleRun(ctx.orgId, ctx.params.id, ctx.actor);
  return apiData(serializePaymentRuleRun(await getPaymentRuleRun(ctx.orgId, ctx.params.id)));
}, { scope: "admin" });

export const spec = {
  retry: {
    path: "/api/v1/PaymentRuleRun/{id}/retry",
    method: "POST",
    summary: "Fehlgeschlagenen Lauf wiederholen (nur Status FAILED, sonst 422)",
    scope: "admin",
    response: apiDataResponseSchema(paymentRuleRunSchema),
    errors: [401, 403, 404, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
