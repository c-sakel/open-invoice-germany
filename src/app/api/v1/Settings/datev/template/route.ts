/** POST /api/v1/Settings/datev/template — Vorlage SKR03/SKR04 als Vorschlag uebernehmen (Scope admin). Bestaetigt nie. */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { datevTemplateResultSchema } from "@/api/serializers/datev";
import { applyDatevTemplate } from "@/domain/export/datev/mapping";
import { datevTemplateInputSchema } from "@/schemas/datev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req, ctx) => {
  const input = datevTemplateInputSchema.parse(ctx.body ?? {});
  return apiData(await applyDatevTemplate(ctx.orgId, input.chart, ctx.actor, { overwriteEdited: input.overwriteEdited }));
}, { scope: "admin" });

export const spec = {
  create: {
    path: "/api/v1/Settings/datev/template",
    method: "POST",
    summary: "Kontenrahmen-Vorlage als Vorschlag uebernehmen (fehlende Zeilen ergaenzen); die Vorlage ist keine Bestaetigung",
    scope: "admin",
    request: { body: datevTemplateInputSchema },
    response: apiDataResponseSchema(datevTemplateResultSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
