/**
 * /api/v1/PostalJob/{id} — Auftrag mit Ereignissen lesen (read) bzw. stornieren (write; binnen 15 Minuten,
 * nur QUEUED/HOLD/DRAFT, sonst 409 NOT_CANCELLABLE). Fremde IDs: 404 (kein Existenz-Orakel).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { postalJobSchema, serializePostalJob } from "@/api/serializers/postal";
import { cancelPostalJob } from "@/domain/postal/cancel";
import { getPostalJob } from "@/domain/postal/list";
import { postalCancelQuerySchema } from "@/schemas/postal";
import { checkPostalRateLimit } from "@/domain/postal/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const { job, events } = await getPostalJob(ctx.orgId, ctx.params.id);
  return apiData(serializePostalJob(job, events));
}, { scope: "read" });

export const DELETE = withApi<{ id: string }>(async (req, ctx) => {
  postalCancelQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  checkPostalRateLimit(ctx.orgId);
  return apiData(await cancelPostalJob(ctx.orgId, ctx.params.id, { actor: ctx.actor }));
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/PostalJob/{id}",
    method: "GET",
    summary: "Postauftrag mit Ereignissen lesen",
    scope: "read",
    response: apiDataResponseSchema(postalJobSchema),
    errors: [401, 403, 404, 429],
  },
  cancel: {
    path: "/api/v1/PostalJob/{id}",
    method: "DELETE",
    summary: "Postauftrag stornieren (binnen 15 Minuten nach der Uebertragung; Query confirm=true Pflicht)",
    scope: "write",
    request: { query: postalCancelQuerySchema },
    response: apiDataResponseSchema(z.object({ status: z.literal("CANCELLED") })),
    errors: [400, 401, 403, 404, 409, 429, 502],
  },
} satisfies Record<string, RouteSpec>;
