/**
 * /api/v1/Settings/postal — Postversand-Einstellungen (Phase 16d). Scope admin.
 * Lesen ohne Zugangsdaten (nur hasApiKey/apiKeyLast4). Schreiben nur Druckoptionen:
 * Zugangsdaten, Schalter (enabled, mode, autoDunningPost) und Budget sind nur in der Oberflaeche aenderbar
 * (das strikte Schema lehnt jedes weitere Feld mit 400 ab).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { postalSettingsSchema, serializePostalSettings } from "@/api/serializers/postal";
import { loadPostalSettings, savePostalSettings } from "@/domain/postal/settings";
import { postalPrintOptionsSchema } from "@/schemas/postal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(serializePostalSettings(await loadPostalSettings(ctx.orgId))), { scope: "admin" });

export const PUT = withApi(async (_req, ctx) => {
  const input = postalPrintOptionsSchema.parse(ctx.body ?? {});
  return apiData(serializePostalSettings(await savePostalSettings(ctx.orgId, input, { actor: ctx.actor, source: "API" })));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/Settings/postal",
    method: "GET",
    summary: "Postversand-Einstellungen lesen (ohne Zugangsdaten)",
    scope: "admin",
    response: apiDataResponseSchema(postalSettingsSchema),
    errors: [401, 403, 429],
  },
  update: {
    path: "/api/v1/Settings/postal",
    method: "PUT",
    summary: "Druckoptionen des Postversands setzen (Zugangsdaten und Schalter nur in der Oberflaeche)",
    scope: "admin",
    request: { body: postalPrintOptionsSchema },
    response: apiDataResponseSchema(postalSettingsSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
