import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeLayout, serializeLayoutDesign, layoutSchema } from "@/api/serializers/layout";
import { listLayouts } from "@/lib/pdf/layouts/registry";
import { isLayoutId } from "@/lib/pdf/layouts/ids";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { getLayoutDesign } from "@/domain/layout-design/list";
import { updateLayoutDesign } from "@/domain/layout-design/save";
import { layoutDesignConfigSchema } from "@/schemas/layout-design";
import { ValidationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PRESET_READONLY = "Vorlagen sind nicht änderbar — Design aus Vorlage anlegen.";

const updateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    config: layoutDesignConfigSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const id = ctx.params.id;
  if (isLayoutId(id)) {
    const preset = listLayouts().find((l) => l.id === id);
    if (preset) return apiData(serializeLayout(preset, presetConfig(id)));
  }
  return apiData(serializeLayoutDesign(await getLayoutDesign(ctx.orgId, id), true));
}, { scope: "read" });

export const PUT = withApi<{ id: string }>(async (_req, ctx) => {
  const id = ctx.params.id;
  if (isLayoutId(id)) throw new ValidationError(PRESET_READONLY);
  const body = updateBodySchema.parse(ctx.body);
  const updated = await updateLayoutDesign(ctx.orgId, id, body, ctx.actor);
  return apiData(serializeLayoutDesign(updated, true));
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/Layout/{id}",
    method: "GET",
    summary: "Layout abrufen: Design (mit `config`) oder feste Vorlage (mit der Startkonfiguration der Vorlage)",
    scope: "read",
    response: apiDataResponseSchema(layoutSchema),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/Layout/{id}",
    method: "PUT",
    summary: "Layout-Design aendern (neue Konfiguration = neue Version) oder archivieren; Vorlagen sind nicht aenderbar (400)",
    scope: "write",
    request: { body: updateBodySchema },
    response: apiDataResponseSchema(layoutSchema),
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
