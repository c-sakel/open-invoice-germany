/**
 * POST /api/v1/BankTransaction/{id}/return — Ruecklastschrift/Rueckbuchung bestaetigen: die betroffene
 * Zahlung wird per Gegenbuchung storniert. Ein Rueckbuchungs-Umsatz wird nie als Zahlung gebucht.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankReturnResultSchema, serializeBankReturnResult } from "@/api/serializers/bank";
import { confirmBankReturn } from "@/domain/bank/return";
import { bankReturnInputSchema, parseBankId } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) =>
  apiData(serializeBankReturnResult(await confirmBankReturn(ctx.orgId, parseBankId(ctx.params.id), ctx.body, { actor: ctx.actor, createdBy: "api" }))),
{ scope: "write" });

export const spec = {
  return: {
    path: "/api/v1/BankTransaction/{id}/return",
    method: "POST",
    summary: "Rückbuchung bestätigen: die gewählte Zahlung wird per Gegenbuchung storniert; feeCents = Rückgabegebühr der Bank (nie gebucht), partial = nur Teilbetrag gegengebucht. Nur bei Lastschrift-Rückgaben (Soll)",
    scope: "write",
    request: { body: bankReturnInputSchema },
    response: apiDataResponseSchema(bankReturnResultSchema),
    errors: [400, 401, 403, 404, 409, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
