/**
 * /api/v1/Settings/datev — DATEV-Einstellungen (Scope admin). PUT ist ein Teil-Update. Jede Aenderung macht
 * eine bestehende Bestaetigung der Kontenzuordnung hinfaellig; bestaetigt wird nur in der Oberflaeche.
 */
import { ZodError } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { DATEV_UI_ONLY_MESSAGE, datevSettingsSchema, serializeDatevSettings } from "@/api/serializers/datev";
import { getDatevSettings, saveDatevSettings } from "@/domain/export/datev/settings";
import { DATEV_UI_ONLY_KEYS, datevSettingsInputSchema } from "@/schemas/datev";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(serializeDatevSettings(await getDatevSettings(ctx.orgId))), { scope: "admin" });

export const PUT = withApi(async (_req, ctx) => {
  const body = ctx.body ?? {};
  if (typeof body === "object" && body !== null && DATEV_UI_ONLY_KEYS.some((k) => k in body)) {
    throw new ZodError([{ code: "custom", path: [], message: DATEV_UI_ONLY_MESSAGE }]);
  }
  const input = datevSettingsInputSchema.parse(body);
  if (Object.keys(input).length === 0) throw new ZodError([{ code: "custom", path: [], message: "Mindestens ein Feld angeben." }]);
  return apiData(serializeDatevSettings(await saveDatevSettings(ctx.orgId, input, ctx.actor)));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/Settings/datev",
    method: "GET",
    summary: "DATEV-Einstellungen und Bestaetigungsstand lesen",
    scope: "admin",
    response: apiDataResponseSchema(datevSettingsSchema),
    errors: [401, 403, 429],
  },
  update: {
    path: "/api/v1/Settings/datev",
    method: "PUT",
    summary: "DATEV-Einstellungen setzen (Teil-Update); macht eine bestehende Bestaetigung der Kontenzuordnung hinfaellig",
    scope: "admin",
    request: { body: datevSettingsInputSchema },
    response: apiDataResponseSchema(datevSettingsSchema),
    errors: [400, 401, 403, 422, 429],
    errorNotes: { 400: "Bestaetigungsfelder (confirmed, confirmedNote) werden abgelehnt: die Bestaetigung gibt es nur in der Oberflaeche." },
  },
} satisfies Record<string, RouteSpec>;
