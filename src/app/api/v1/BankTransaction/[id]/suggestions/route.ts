/**
 * GET /api/v1/BankTransaction/{id}/suggestions — Zuordnungsvorschlaege (Gutschrift) bzw. Rueckgabe-Vorschlaege
 * (Rueckbuchung). Rein lesend, es wird nie gebucht.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { bankSuggestionsResultSchema } from "@/api/serializers/bank";
import { bankSuggestionsForApi } from "@/domain/bank/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => apiData(await bankSuggestionsForApi(ctx.orgId, ctx.params.id)), { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/BankTransaction/{id}/suggestions",
    method: "GET",
    summary: "Zuordnungsvorschläge (bei Rückbuchungen: betroffene Zahlungen) für einen Umsatz; bucht nie",
    scope: "read",
    response: apiDataResponseSchema(bankSuggestionsResultSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
