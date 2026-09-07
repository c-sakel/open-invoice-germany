import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiList } from "@/api/response";
import { apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeLayout } from "@/api/serializers/layout";
import { listLayouts } from "@/lib/pdf/layouts/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phase 11b, Task 8 — feste Liste der sieben PDF-Layouts (keine Paginierung, keine DB-Tabelle). */
export const GET = withApi(async () => {
  const rows = listLayouts().map(serializeLayout);
  return apiList(rows, { total: rows.length, limit: rows.length, offset: 0 });
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/Layout",
    method: "GET",
    summary: "PDF-Layouts auflisten",
    scope: "read",
    response: apiListResponseSchema(z.unknown()),
    errors: [401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
