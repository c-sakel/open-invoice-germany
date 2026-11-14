/**
 * POST /api/v1/BankTransaction/{id}/undo — Zuordnung per Gegenbuchung der Zahlung zuruecknehmen (mit Grund).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankViewSchema, serializeBankView } from "@/api/serializers/bank";
import { undoBankMatch } from "@/domain/bank/confirm";
import { bankUndoInputSchema, parseBankId } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) =>
  apiData(serializeBankView(await undoBankMatch(ctx.orgId, parseBankId(ctx.params.id), ctx.body, { actor: ctx.actor, createdBy: "api" }))),
{ scope: "write" });

export const spec = {
  undo: {
    path: "/api/v1/BankTransaction/{id}/undo",
    method: "POST",
    summary: "Zuordnung zurücknehmen: die Zahlung wird per Gegenbuchung storniert (Grund Pflicht)",
    scope: "write",
    request: { body: bankUndoInputSchema },
    response: apiDataResponseSchema(bankViewSchema),
    errors: [400, 401, 403, 404, 409, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
