/**
 * GET /api/v1/BankTransaction — Bankumsaetze auflisten (Filter status, from, to; Cursor). IBAN maskiert.
 */
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { bankTransactionSchema, serializeBankTransaction } from "@/api/serializers/bank";
import { listBankTransactions } from "@/domain/bank/list";
import { bankListQuerySchema } from "@/schemas/bank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const result = await listBankTransactions(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams));
  return apiList(result.rows.map(serializeBankTransaction), { total: result.total, limit: result.limit, offset: 0, nextCursor: result.nextCursor });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/BankTransaction",
    method: "GET",
    summary: "Bankumsätze auflisten (status, from, to als YYYY-MM-DD, limit 1..200, Cursor); IBAN maskiert, Beträge in Cent",
    scope: "read",
    request: { query: bankListQuerySchema },
    response: apiListResponseSchema(bankTransactionSchema, { sync: true }),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
