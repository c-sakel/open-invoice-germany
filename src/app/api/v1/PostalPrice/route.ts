/**
 * GET /api/v1/PostalPrice — Preisabfrage beim Briefdienst (Phase 16d). Scope write (kostenfreie, aber
 * externe Abfrage; nur bei aktiviertem Postversand).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { queryPostalPrice } from "@/domain/postal/connection";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";
import { postalPriceQuerySchema } from "@/schemas/postal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  checkPostalRateLimit(ctx.orgId);
  const q = Object.fromEntries(new URL(req.url).searchParams);
  return apiData(await queryPostalPrice(ctx.orgId, q));
}, { scope: "write" });

export const spec = {
  price: {
    path: "/api/v1/PostalPrice",
    method: "GET",
    summary: "Preis eines Briefs abfragen (Seiten, Farbe, Duplex, Versandart, Einschreiben)",
    scope: "write",
    request: { query: postalPriceQuerySchema },
    response: apiDataResponseSchema(z.object({ priceCents: z.number().int() })),
    errors: [400, 401, 403, 409, 429, 502],
  },
} satisfies Record<string, RouteSpec>;
