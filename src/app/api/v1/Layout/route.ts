import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeLayout, serializeLayoutDesign, layoutSchema } from "@/api/serializers/layout";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { listLayoutDesigns } from "@/domain/layout-design/list";
import { saveLayoutDesign, layoutDesignSaveSchema } from "@/domain/layout-design/save";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listQuerySchema = z.object({ includeArchived: z.enum(["true", "false"]).optional() });

// POST legt immer neu an — eine mitgesendete `id` wird abgelehnt (strict), Aenderungen laufen ueber PUT.
const createBodySchema = layoutDesignSaveSchema.omit({ id: true });

/** Phase 11b/16g — die sieben festen Vorlagen plus die Designs der Organisation (keine Paginierung). */
export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const query = listQuerySchema.parse({ includeArchived: searchParams.get("includeArchived") ?? undefined });
  const designs = await listLayoutDesigns(ctx.orgId, { includeArchived: query.includeArchived === "true" });
  const rows = [...listLayouts().map((l) => serializeLayout(l)), ...designs.map((d) => serializeLayoutDesign(d))];
  return apiList(rows, { total: rows.length, limit: rows.length, offset: 0 });
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const input = createBodySchema.parse(ctx.body);
  const created = await saveLayoutDesign(ctx.orgId, input, ctx.actor);
  return apiData(serializeLayoutDesign(created, true), 201);
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/Layout",
    method: "GET",
    summary: "PDF-Layouts auflisten: sieben feste Vorlagen (kind=preset) und Designs der Organisation (kind=design; `includeArchived=true` schliesst archivierte ein). Keine Paginierung, `limit`/`offset` werden ignoriert.",
    scope: "read",
    request: { query: listQuerySchema },
    response: apiListResponseSchema(layoutSchema),
    errors: [400, 401, 403, 429],
  },
  create: {
    path: "/api/v1/Layout",
    method: "POST",
    summary: "Layout-Design anlegen (Version 1; ohne `config` aus der Startvorlage `baseLayoutId`)",
    scope: "write",
    request: { body: createBodySchema },
    response: apiDataResponseSchema(layoutSchema),
    errors: [400, 401, 403, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
