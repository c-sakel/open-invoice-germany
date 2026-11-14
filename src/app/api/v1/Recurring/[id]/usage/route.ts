/**
 * /api/v1/Recurring/{id}/usage — Verbrauch eines Abos (Phase 18f, Task 7).
 * GET listet (scope read), POST erfasst (scope write). Idempotenz je Satz ueber `externalId`
 * (gleiche Nutzlast -> 200 replayed, andere -> 409); zusaetzlich greift der generische
 * Idempotency-Key von withApi. Alle Writes laufen ueber recordUsage (Abo-Sperre, Org-Scope).
 */
import { NextResponse } from "next/server";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import type { RouteSpec } from "@/api/spec";
import { serializeUsage, serializeOpenUsage, usageListResponseSchema, usageRecordResponseSchema } from "@/api/serializers/recurring-usage";
import { listUsage, recordUsage } from "@/domain/recurring/usage";
import { listUsageQuerySchema, recordUsageSchema } from "@/schemas/recurring-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (req, ctx) => {
  const query = listUsageQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  const res = await listUsage(ctx.orgId, ctx.params.id, query);
  return NextResponse.json({
    data: res.items.map(serializeUsage),
    total: res.total,
    limit: query.limit,
    offset: 0,
    nextCursor: res.nextCursor,
    meta: { open: res.open.map(serializeOpenUsage) },
  });
}, { scope: "read" });

export const POST = withApi<{ id: string }>(async (_req, ctx) => {
  const { usage, replayed } = await recordUsage(ctx.orgId, ctx.params.id, ctx.body, { source: "API", actor: ctx.actor });
  if (replayed) return NextResponse.json({ data: serializeUsage(usage), replayed: true }, { status: 200 });
  return apiData(serializeUsage(usage), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Recurring/{id}/usage",
    method: "GET",
    summary: "Verbrauch eines Abos auflisten (status open|billed|voided|all, Cursor-Seitenwechsel; meta.open = offene Menge je Position)",
    scope: "read",
    request: { query: listUsageQuerySchema },
    response: usageListResponseSchema,
    errors: [400, 401, 403, 404, 429],
  },
  create: {
    path: "/api/v1/Recurring/{id}/usage",
    method: "POST",
    summary: "Verbrauch erfassen (quantityMilli in tausendstel Einheiten; gleiche externalId + Nutzlast -> 200 replayed, andere Nutzlast -> 409)",
    scope: "write",
    request: { body: recordUsageSchema },
    response: usageRecordResponseSchema,
    errors: [400, 401, 403, 404, 409, 413, 422, 429],
    errorNotes: {
      409: "error.code CONFLICT: externalId wurde bereits mit anderen Daten verwendet.",
      422: "Fachlicher Code in error.code: NOT_ACTIVE, NOT_USAGE_LINE, PERIOD_BILLED, AFTER_END, IN_FUTURE, ALREADY_BILLED, ALREADY_VOIDED.",
    },
  },
} satisfies Record<string, RouteSpec>;
