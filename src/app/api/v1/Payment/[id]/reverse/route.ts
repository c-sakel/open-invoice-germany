/**
 * POST /api/v1/Payment/{id}/reverse — Zahlung per Gegenbuchung korrigieren (Phase 16a, GoBD).
 * Ruft exakt `reversePayment`; die urspruengliche Zahlung bleibt unveraendert, die Antwort ist
 * die neue (negative) Gegenbuchung. Org-Zugehoerigkeit prueft die Domain (404 fuer Fremdes).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializePayment, paymentSchema } from "@/api/serializers/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { reversePaymentInputSchema } from "@/schemas/payment-correction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const input = reversePaymentInputSchema.parse(ctx.body);
  const result = await reversePayment(ctx.params.id, input, { actor: ctx.actor, orgId: ctx.orgId, createdBy: "api" });
  return apiData(serializePayment(result.reversal), 201);
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Payment/{id}/reverse",
    method: "POST",
    summary: "Zahlung per Gegenbuchung korrigieren (liefert die Gegenbuchung)",
    scope: "write",
    request: { body: reversePaymentInputSchema },
    response: apiDataResponseSchema(paymentSchema),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
