import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeLayoutVersion, layoutVersionSchema } from "@/api/serializers/layout";
import { listLayoutDesignVersions } from "@/domain/layout-design/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const rows = (await listLayoutDesignVersions(ctx.orgId, ctx.params.id)).map(serializeLayoutVersion);
  return apiList(rows, { total: rows.length, limit: rows.length, offset: 0 });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/Layout/{id}/versions",
    method: "GET",
    summary: "Versionen eines Layout-Designs (aufsteigend, unveraenderlich; keine Paginierung)",
    scope: "read",
    response: apiListResponseSchema(layoutVersionSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
