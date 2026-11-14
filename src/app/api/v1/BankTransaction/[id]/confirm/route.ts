/**
 * POST /api/v1/BankTransaction/{id}/confirm — Zuordnung bestaetigen (auch aufgeteilt). Bucht ueber den
 * Zahlungsdienst; `expectedAllocatedCents` schuetzt vor parallelen Aenderungen (409). Ein Ueberschuss wird nie gebucht.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankConfirmResultSchema, serializeConfirmResult } from "@/api/serializers/bank";
import { confirmBankMatch } from "@/domain/bank/confirm";
import { bankConfirmInputSchema, parseBankId } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) =>
  apiData(serializeConfirmResult(await confirmBankMatch(ctx.orgId, parseBankId(ctx.params.id), ctx.body, { actor: ctx.actor, createdBy: "api" }))),
{ scope: "write" });

export const spec = {
  confirm: {
    path: "/api/v1/BankTransaction/{id}/confirm",
    method: "POST",
    summary: "Umsatz einer oder mehreren Rechnungen zuordnen und die Zahlungen buchen (expectedAllocatedCents Pflicht)",
    scope: "write",
    request: { body: bankConfirmInputSchema },
    response: apiDataResponseSchema(bankConfirmResultSchema),
    errors: [400, 401, 403, 404, 409, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
