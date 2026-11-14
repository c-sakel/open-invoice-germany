/**
 * POST /api/v1/BankTransaction/confirm-unambiguous — alle (oder die genannten) offenen Umsaetze mit genau
 * einem sicheren Vorschlag bestaetigen. Je Umsatz eigene Buchung; Ergebnisbericht mit uebersprungenen Umsaetzen.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankUnambiguousResultSchema } from "@/api/serializers/bank";
import { confirmUnambiguous } from "@/domain/bank/confirm";
import { bankConfirmUnambiguousInputSchema } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req, ctx) =>
  apiData(await confirmUnambiguous(ctx.orgId, ctx.body, { actor: ctx.actor, createdBy: "api" })),
{ scope: "write" });

export const spec = {
  confirmUnambiguous: {
    path: "/api/v1/BankTransaction/confirm-unambiguous",
    method: "POST",
    summary: "Eindeutige Vorschläge sammelhaft bestätigen (höchstens 200 Umsätze je Aufruf; optional transactionIds)",
    scope: "write",
    request: { body: bankConfirmUnambiguousInputSchema },
    response: apiDataResponseSchema(bankUnambiguousResultSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
