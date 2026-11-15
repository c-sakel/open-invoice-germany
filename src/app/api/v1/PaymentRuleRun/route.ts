/** GET (read): Laeufe der Regeln nach Zahlungseingang, Filter status|ruleId|invoiceId|paymentId. */
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { paymentRuleRunSchema, serializePaymentRuleRun } from "@/api/serializers/payment-rule";
import { listPaymentRuleRuns } from "@/domain/payment-rule/runs";
import { paymentRuleRunListFilterSchema } from "@/schemas/payment-rule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const raw = Object.fromEntries(new URL(req.url).searchParams.entries());
  const filter = paymentRuleRunListFilterSchema.parse(raw);
  const { rows, total } = await listPaymentRuleRuns(ctx.orgId, filter);
  return apiList(rows.map(serializePaymentRuleRun), { total, limit: filter.limit, offset: filter.offset });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/PaymentRuleRun",
    method: "GET",
    summary: "Laeufe der Regeln nach Zahlungseingang auflisten (neueste zuerst)",
    scope: "read",
    request: { query: paymentRuleRunListFilterSchema },
    response: apiListResponseSchema(paymentRuleRunSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
