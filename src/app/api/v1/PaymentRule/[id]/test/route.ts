/** POST: Trockenlauf einer Regel gegen eine Rechnung (rein lesend, versendet und schreibt nichts). */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { paymentRulePreviewSchema } from "@/api/serializers/payment-rule";
import { previewPaymentRule } from "@/domain/payment-rule/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testBodySchema = z.object({ invoiceId: z.string().min(1) });

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const { invoiceId } = testBodySchema.parse(ctx.body);
  return apiData(await previewPaymentRule(ctx.orgId, ctx.params.id, invoiceId));
}, { scope: "admin" });

export const spec = {
  test: {
    path: "/api/v1/PaymentRule/{id}/test",
    method: "POST",
    summary: "Trockenlauf: zeigt, ob die Regel fuer die Rechnung greift, und die Schritte inkl. Mailvorschau (schreibt nichts)",
    scope: "admin",
    request: { body: testBodySchema },
    response: apiDataResponseSchema(paymentRulePreviewSchema),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
