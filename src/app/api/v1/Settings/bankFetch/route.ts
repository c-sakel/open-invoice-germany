/** GET /api/v1/Settings/bankFetch — Status des Kontoabrufs. Nur lesend; Einrichtung und Abruf gibt es nur in der Oberfläche. */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankFetchStatusSchema, serializeBankFetchStatus } from "@/api/serializers/bank-fetch";
import { loadBankFetchStatus } from "@/domain/bank-fetch/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(serializeBankFetchStatus(await loadBankFetchStatus(ctx.orgId))), { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/Settings/bankFetch",
    method: "GET",
    summary: "Status des Kontoabrufs lesen (Kennung und IBAN maskiert, keine Zugangsdaten; Einrichtung und Abruf nur in der Oberfläche)",
    scope: "read",
    response: apiDataResponseSchema(bankFetchStatusSchema),
    errors: [401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
