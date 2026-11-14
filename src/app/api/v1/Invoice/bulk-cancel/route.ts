/**
 * POST /api/v1/Invoice/bulk-cancel — Sammel-Storno (Phase 18d, Domain aus 18c).
 * Je Beleg eigene Storno-Gutschrift, seriell, Ergebnis je Beleg; kein Versand. Das statische Segment
 * hat Vorrang vor `[id]` (Ids sind cuid).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { cancelInvoicesBulk } from "@/domain/invoice/bulk-cancel";
import { rateLimit } from "@/lib/rate-limit";
import { bulkCancelSchema } from "@/schemas";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req, ctx) => {
  rateLimit("api-bulk-cancel:" + ctx.orgId, { limit: 10, windowMs: 60_000 });
  const result = await cancelInvoicesBulk(ctx.orgId, ctx.body, { actor: ctx.actor });
  return apiData(result);
}, { scope: "write" });

export const spec = {
  create: {
    path: "/api/v1/Invoice/bulk-cancel",
    method: "POST",
    summary: "Mehrere Rechnungen stornieren (je Beleg eigene Storno-Gutschrift, seriell, Ergebnis je Beleg)",
    scope: "write",
    request: { body: bulkCancelSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
