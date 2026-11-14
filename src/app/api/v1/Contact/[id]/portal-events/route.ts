/**
 * GET /api/v1/Contact/{id}/portal-events — Abrufprotokoll des Kundenportals (neueste zuerst, ohne IP).
 * Query: limit 1..200 (Standard 50), cursor (nextCursor der Vorseite).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { portalEventSchema, serializePortalEvent } from "@/api/serializers/portal";
import { countPortalEvents, listPortalEvents } from "@/domain/portal/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(64).optional(),
});

export const GET = withApi<{ id: string }>(async (req, ctx) => {
  const q = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
  const { items, nextCursor } = await listPortalEvents(ctx.orgId, ctx.params.id, { limit: q.limit, cursor: q.cursor });
  const total = await countPortalEvents(ctx.orgId, ctx.params.id);
  return apiList(items.map(serializePortalEvent), { total, limit: q.limit, offset: 0, nextCursor });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/Contact/{id}/portal-events",
    method: "GET",
    summary: "Abrufprotokoll des Kundenportals (neueste zuerst, ohne IP; limit 1..200, cursor)",
    scope: "read",
    response: apiListResponseSchema(portalEventSchema, { sync: true }),
    errors: [400, 401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
