/**
 * GET /api/v1/Report/smallBusiness — Umsatzgrenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG):
 * vereinnahmter und berechneter Netto-Umsatz des Jahres (Standard: aktuelles Berliner Jahr) und des
 * Vorjahres gegen 25.000 EUR / 100.000 EUR. Rein lesend; die Rechnung liegt in `kuThreshold`
 * (src/domain/reporting/ku.ts), identisch fuer MCP.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { kuQuerySchema, kuThresholdSchema } from "@/api/serializers/small-business";
import { kuThreshold } from "@/domain/reporting/ku";
import { berlinYear } from "@/lib/berlin-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const query = kuQuerySchema.parse(Object.fromEntries(searchParams));
  return apiData(await kuThreshold(ctx.orgId, query.year ?? berlinYear(new Date())));
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/Report/smallBusiness",
    method: "GET",
    summary: "Umsatzgrenzen der Kleinunternehmerregelung auswerten (§ 19 UStG, laufendes Jahr und Vorjahr)",
    scope: "read",
    request: { query: kuQuerySchema },
    response: apiDataResponseSchema(kuThresholdSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
