/**
 * /api/v1/Tag — Tags (Ordnungsmerkmal ueber Belegen, Phase 13d, Task 5, Muster
 * src/app/api/v1/TextTemplate/route.ts). `saveTag` (src/domain/tag/manage.ts) liefert
 * die rohe Prisma-Zeile ohne `documentCount` — ein frisch angelegter Tag hat noch keine
 * Zuordnung, `documentCount: 0` ist deshalb korrekt ohne einen zweiten Datenbankzugriff.
 */
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeTag, tagSchema } from "@/api/serializers/tag";
import { listTagsApi, tagListApiFilterSchema } from "@/domain/tag/list";
import { saveTag, TagNameConflictError } from "@/domain/tag/manage";
import { tagInputSchema } from "@/schemas/tag";
import { InvalidOperationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const result = await listTagsApi(ctx.orgId, Object.fromEntries(searchParams));
  return apiList(result.rows.map(serializeTag), result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  try {
    const created = await saveTag(ctx.orgId, null, ctx.body);
    return apiData(serializeTag({ ...created, documentCount: 0 }), 201);
  } catch (e) {
    if (e instanceof TagNameConflictError) throw new InvalidOperationError(e.message);
    throw e;
  }
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Tag",
    method: "GET",
    summary: "Tags auflisten",
    scope: "read",
    request: { query: tagListApiFilterSchema },
    response: apiListResponseSchema(tagSchema),
    errors: [400, 401, 403, 429],
  },
  create: {
    path: "/api/v1/Tag",
    method: "POST",
    summary: "Tag anlegen",
    scope: "write",
    request: { body: tagInputSchema },
    response: apiDataResponseSchema(tagSchema),
    errors: [400, 401, 403, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
