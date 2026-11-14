/**
 * POST /api/v1/BankTransaction/{id}/reopen — ignorierten Umsatz wieder oeffnen.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankViewSchema, serializeBankView } from "@/api/serializers/bank";
import { reopenBankTransaction } from "@/domain/bank/confirm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) =>
  apiData(serializeBankView(await reopenBankTransaction(ctx.orgId, ctx.params.id, { actor: ctx.actor, createdBy: "api" }))),
{ scope: "write" });

export const spec = {
  reopen: {
    path: "/api/v1/BankTransaction/{id}/reopen",
    method: "POST",
    summary: "Ignorierten Umsatz wieder öffnen (ohne Zuordnung)",
    scope: "write",
    response: apiDataResponseSchema(bankViewSchema),
    errors: [401, 403, 404, 409, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
