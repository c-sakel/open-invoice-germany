/**
 * GET /api/v1/Report/oss — OSS-Schwelle (Phase 16e, § 3c Abs. 4 UStG): EU-B2C-Netto-Umsatz des
 * Jahres (Standard: aktuelles Berliner Jahr) und des Vorjahres gegen 10.000 EUR. Rein lesend; die
 * Rechnung liegt in `ossThreshold` (src/domain/reporting/oss.ts), identisch fuer MCP.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { ossQuerySchema, ossThresholdSchema } from "@/api/serializers/oss";
import { ossThreshold } from "@/domain/reporting/oss";
import { berlinYear } from "@/lib/berlin-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const query = ossQuerySchema.parse(Object.fromEntries(searchParams));
  return apiData(await ossThreshold(ctx.orgId, query.year ?? berlinYear(new Date())));
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/Report/oss",
    method: "GET",
    summary: "OSS-Schwelle auswerten (EU-B2C-Umsatz laufendes Jahr und Vorjahr gegen 10.000 EUR)",
    scope: "read",
    request: { query: ossQuerySchema },
    response: apiDataResponseSchema(ossThresholdSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
