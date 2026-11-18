/** GET /api/v1/BankFetchRun — Abrufprotokoll je Konto; mit updatedSince (Anlagezeitpunkt) Abgleich per Cursor. */
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { bankFetchRunSchema, serializeBankFetchRun } from "@/api/serializers/bank-fetch";
import { listBankFetchRuns } from "@/domain/bank-fetch/status";
import { bankFetchRunListQuerySchema } from "@/schemas/bank-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const r = await listBankFetchRuns(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams));
  return apiList(r.items.map(serializeBankFetchRun), { total: r.total, limit: r.limit, offset: r.offset, ...(r.nextCursor !== null ? { nextCursor: r.nextCursor } : {}) });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/BankFetchRun",
    method: "GET",
    summary: "Abrufprotokoll des Kontoabrufs auflisten (neueste zuerst; Filter connectionId; mit updatedSince Abgleich per Cursor, bezogen auf den Anlagezeitpunkt)",
    scope: "read",
    request: { query: bankFetchRunListQuerySchema },
    response: apiListResponseSchema(bankFetchRunSchema, { sync: true }),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
