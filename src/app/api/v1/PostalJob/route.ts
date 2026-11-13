/**
 * /api/v1/PostalJob — Postauftraege (Phase 16d).
 * GET (read): Liste mit Filtern. POST (write): kostenpflichtiger Versand bzw. Trockenlauf fuer 1..100 Belege.
 * Pflicht: Header `Idempotency-Key` (sonst 400), `confirm: true`, je Beleg `expectedPriceCents` und `pdfSha256`
 * aus dem Angebot (`POST /api/v1/PostalQuote`). Antwort 200 mit Ergebnis je Beleg (`status` oder `REJECTED` mit `code`);
 * sind ALLE Belege wegen veralteten Angebots abgelehnt (PRICE_CHANGED, PDF_CHANGED, PRICE_UNAVAILABLE mit gleichem Code),
 * antwortet die Route 409 mit `reason` = Code und den Ergebnissen in `details.results`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { postalJobSchema, postalSendResultSchema, serializePostalJob } from "@/api/serializers/postal";
import { listPostalJobs } from "@/domain/postal/list";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";
import { sendByPost } from "@/domain/postal/send";
import { postalJobListFilterSchema, postalSendInputSchema } from "@/schemas/postal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STALE_CODES = new Set(["PRICE_CHANGED", "PDF_CHANGED", "PRICE_UNAVAILABLE"]);

export const GET = withApi(async (req, ctx) => {
  const result = await listPostalJobs(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams));
  return apiList(result.rows.map((r) => serializePostalJob(r)), result);
}, { scope: "read" });

export const POST = withApi(async (req, ctx) => {
  if (!req.headers.get("idempotency-key")?.trim()) {
    throw new z.ZodError([{ code: "custom", path: ["Idempotency-Key"], message: "Der Header Idempotency-Key ist fuer den Postversand Pflicht." }]);
  }
  const input = postalSendInputSchema.parse(ctx.body);
  checkPostalRateLimit(ctx.orgId);
  const results = await sendByPost(ctx.orgId, input, { actor: ctx.actor, trigger: "API" });
  const codes = new Set(results.map((r) => (r.status === "REJECTED" ? r.code : undefined)));
  const [only] = [...codes];
  if (codes.size === 1 && only && STALE_CODES.has(only)) {
    return NextResponse.json(
      { error: { code: "CONFLICT", message: results[0]?.error ?? "Das Angebot ist veraltet.", reason: only, details: { results } } },
      { status: 409 },
    );
  }
  return apiData({ results });
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/PostalJob",
    method: "GET",
    summary: "Postauftraege auflisten (Filter: status, docType, docId, mode)",
    scope: "read",
    request: { query: postalJobListFilterSchema },
    response: apiListResponseSchema(postalJobSchema),
    errors: [400, 401, 403, 429],
  },
  send: {
    path: "/api/v1/PostalJob",
    method: "POST",
    summary: "Belege per Post senden (kostenpflichtig im Modus LIVE; Idempotency-Key Pflicht, confirm: true)",
    scope: "write",
    request: { body: postalSendInputSchema },
    response: apiDataResponseSchema(z.object({ results: z.array(postalSendResultSchema) })),
    errors: [400, 401, 403, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
