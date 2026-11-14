/**
 * POST /api/v1/BankTransaction/{id}/return — Ruecklastschrift/Rueckbuchung bestaetigen: die betroffene
 * Zahlung wird per Gegenbuchung storniert. Ein Rueckbuchungs-Umsatz wird nie als Zahlung gebucht.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankViewSchema, serializeBankView } from "@/api/serializers/bank";
import { confirmBankReturn } from "@/domain/bank/return";
import { bankReturnInputSchema } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) =>
  apiData(serializeBankView(await confirmBankReturn(ctx.orgId, ctx.params.id, ctx.body, { actor: ctx.actor, createdBy: "api" }))),
{ scope: "write" });

export const spec = {
  return: {
    path: "/api/v1/BankTransaction/{id}/return",
    method: "POST",
    summary: "Rückbuchung bestätigen: die gewählte Zahlung wird per Gegenbuchung storniert",
    scope: "write",
    request: { body: bankReturnInputSchema },
    response: apiDataResponseSchema(bankViewSchema),
    errors: [400, 401, 403, 404, 409, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
