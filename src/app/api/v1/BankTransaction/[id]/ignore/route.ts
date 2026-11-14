/**
 * POST /api/v1/BankTransaction/{id}/ignore — Umsatz mit Grund ignorieren (keine Buchung).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankViewSchema, serializeBankView } from "@/api/serializers/bank";
import { ignoreBankTransaction } from "@/domain/bank/confirm";
import { bankIgnoreInputSchema } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ id: string }>(async (_req, ctx) =>
  apiData(serializeBankView(await ignoreBankTransaction(ctx.orgId, ctx.params.id, ctx.body, { actor: ctx.actor, createdBy: "api" }))),
{ scope: "write" });

export const spec = {
  ignore: {
    path: "/api/v1/BankTransaction/{id}/ignore",
    method: "POST",
    summary: "Offenen Umsatz mit Grund ignorieren",
    scope: "write",
    request: { body: bankIgnoreInputSchema },
    response: apiDataResponseSchema(bankViewSchema),
    errors: [400, 401, 403, 404, 409, 422, 429],
  },
} satisfies Record<string, RouteSpec>;
