/**
 * /api/v1/Settings/onlinePayment — Einstellungen der Online-Zahlung. Scope admin. GET liefert nie einen
 * Schluessel (nur hasApiKey, Modus, letztes Testergebnis); PUT aendert nur Standardanbieter und Anzeigeoptionen.
 * Schluessel, Einschalter, Methoden und Waehrungen werden ausschliesslich in der Oberflaeche gepflegt.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { onlinePaymentSettingsSchema, serializeOnlinePaymentSettings } from "@/api/serializers/online-payment";
import { loadOnlinePaymentSettings, saveOnlinePaymentSettings } from "@/domain/online-payment/settings";
import { parseOnlinePaymentSettingsInput } from "@/domain/online-payment/views";
import { onlinePaymentSettingsInputSchema } from "@/schemas/online-payment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (_req, ctx) => apiData(serializeOnlinePaymentSettings(await loadOnlinePaymentSettings(ctx.orgId))), { scope: "admin" });

export const PUT = withApi(async (_req, ctx) => {
  const input = parseOnlinePaymentSettingsInput(ctx.body ?? {});
  return apiData(serializeOnlinePaymentSettings(await saveOnlinePaymentSettings(ctx.orgId, input, ctx.actor)));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/Settings/onlinePayment",
    method: "GET",
    summary: "Einstellungen der Online-Zahlung lesen (ohne Schluessel)",
    scope: "admin",
    response: apiDataResponseSchema(onlinePaymentSettingsSchema),
    errors: [401, 403, 429],
  },
  update: {
    path: "/api/v1/Settings/onlinePayment",
    method: "PUT",
    summary: "Standardanbieter und Anzeigeoptionen setzen (Teil-Update)",
    scope: "admin",
    request: { body: onlinePaymentSettingsInputSchema },
    response: apiDataResponseSchema(onlinePaymentSettingsSchema),
    errors: [400, 401, 403, 429],
    errorNotes: { 400: "Schluessel, Einschalter, Methoden und Waehrungen sind nur in der Oberflaeche aenderbar." },
  },
} satisfies Record<string, RouteSpec>;
