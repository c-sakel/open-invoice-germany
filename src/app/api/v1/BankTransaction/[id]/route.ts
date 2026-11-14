/**
 * GET /api/v1/BankTransaction/{id} — Umsatz mit allen Zuordnungen (Zahlung, Skonto, Rueckname).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankTransactionDetailSchema, serializeBankMatch, serializeBankTransaction } from "@/api/serializers/bank";
import { getBankTransaction } from "@/domain/bank/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const r = await getBankTransaction(ctx.orgId, ctx.params.id);
  return apiData({ transaction: serializeBankTransaction(r.transaction), matches: r.matches.map(serializeBankMatch) });
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/BankTransaction/{id}",
    method: "GET",
    summary: "Bankumsatz mit Zuordnungen abrufen",
    scope: "read",
    response: apiDataResponseSchema(bankTransactionDetailSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
