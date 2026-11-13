/**
 * POST /api/v1/PostalQuote — Angebot (Preis, Pruefsumme, Probleme) fuer 1..100 Belege (Phase 16d).
 * Scope write. Versendet nichts; Preisabfrage nur bei aktiviertem Postversand.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { type RouteSpec } from "@/api/spec";
import { postalQuoteResponseSchema } from "@/api/serializers/postal";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";
import { quotePostal } from "@/domain/postal/send";
import { postalQuoteInputSchema } from "@/schemas/postal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req, ctx) => {
  const { items } = postalQuoteInputSchema.parse(ctx.body);
  checkPostalRateLimit(ctx.orgId);
  return apiData(await quotePostal(ctx.orgId, items));
}, { scope: "write" });

export const spec = {
  quote: {
    path: "/api/v1/PostalQuote",
    method: "POST",
    summary: "Angebot fuer den Postversand (Preis, Pruefsumme, Probleme je Beleg)",
    scope: "write",
    request: { body: postalQuoteInputSchema },
    response: postalQuoteResponseSchema,
    errors: [400, 401, 403, 404, 409, 429, 502],
  },
} satisfies Record<string, RouteSpec>;
