/**
 * POST /api/v1/Settings/onlinePayment/{provider}/test — Verbindungstest mit dem hinterlegten Schluessel.
 * Scope admin. Baut eine echte Verbindung zum Anbieter auf; das Ergebnis wird gespeichert (feste Texte).
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { onlinePaymentTestResultSchema } from "@/api/serializers/online-payment";
import { assertConnectionTestCooldown, testProviderConnection } from "@/domain/online-payment/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi<{ provider: string }>(async (_req, ctx) => {
  await assertConnectionTestCooldown(ctx.orgId, ctx.params.provider);
  return apiData(await testProviderConnection(ctx.orgId, ctx.params.provider, ctx.actor));
}, { scope: "admin" });

export const spec = {
  test: {
    path: "/api/v1/Settings/onlinePayment/{provider}/test",
    method: "POST",
    summary: "Verbindung zum Zahlungsanbieter pruefen (echte Verbindung, speichert das Ergebnis)",
    scope: "admin",
    response: apiDataResponseSchema(onlinePaymentTestResultSchema),
    errors: [400, 401, 403, 422, 429],
    errorNotes: { 422: "reason NO_KEY (kein Schluessel hinterlegt) oder KEY_UNREADABLE.", 429: "Mindestabstand 10 Sekunden je Anbieter." },
  },
} satisfies Record<string, RouteSpec>;
