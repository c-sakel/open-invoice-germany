/**
 * /api/v1/Settings/portal — Einstellungen des Kundenportals. Scope admin (wie die übrigen Einstellungen-Routen); PUT ist ein Teil-Update.
 */
import { ZodError } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { portalSettingsSchema, serializePortalSettings } from "@/api/serializers/portal";
import { loadPortalSettings, savePortalSettings } from "@/domain/portal/settings";
import { portalSettingsInputSchema } from "@/schemas/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(serializePortalSettings(await loadPortalSettings(ctx.orgId))), { scope: "admin" });

export const PUT = withApi(async (_req, ctx) => {
  const input = portalSettingsInputSchema.parse(ctx.body ?? {});
  if (Object.keys(input).length === 0) {
    throw new ZodError([{ code: "custom", path: [], message: "Mindestens ein Feld angeben." }]);
  }
  return apiData(serializePortalSettings(await savePortalSettings(ctx.orgId, input, ctx.actor)));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/Settings/portal",
    method: "GET",
    summary: "Einstellungen des Kundenportals lesen",
    scope: "admin",
    response: apiDataResponseSchema(portalSettingsSchema),
    errors: [401, 403, 429],
  },
  update: {
    path: "/api/v1/Settings/portal",
    method: "PUT",
    summary: "Einstellungen des Kundenportals setzen (Teil-Update, fehlende Felder bleiben)",
    scope: "admin",
    request: { body: portalSettingsInputSchema },
    response: apiDataResponseSchema(portalSettingsSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
