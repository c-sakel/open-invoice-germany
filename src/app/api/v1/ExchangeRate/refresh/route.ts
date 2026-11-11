/**
 * POST /api/v1/ExchangeRate/refresh — EZB-Kurse sofort abrufen (Phase 16b, Task 9). Dieselbe
 * Domain-Funktion wie der Scheduler-Job `fx` und die Oberflaeche. Bei `FX_AUTO_FETCH=0` ist der
 * Abruf abgeschaltet: 409 mit `reason: "disabled"` (kein Netzzugriff). Netz-/Formatfehler der
 * Quelle werden als 502 gemeldet.
 */
import { NextResponse } from "next/server";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { exchangeRateRefreshSchema } from "@/api/serializers/exchange-rate";
import { refreshExchangeRates } from "@/domain/fx/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async () => {
  if (process.env.FX_AUTO_FETCH === "0") {
    return NextResponse.json(
      { error: { code: "CONFLICT", message: "Der automatische Kursabruf ist abgeschaltet (FX_AUTO_FETCH=0).", reason: "disabled" } },
      { status: 409 },
    );
  }
  try {
    return apiData(await refreshExchangeRates(new Date()));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: { code: "INTERNAL", message: `Kursabruf fehlgeschlagen: ${message}`.slice(0, 500), reason: "fetch_failed" } }, { status: 502 });
  }
}, { scope: "admin" });

export const spec = {
  refresh: {
    path: "/api/v1/ExchangeRate/refresh",
    method: "POST",
    summary: "EZB-Kurse jetzt abrufen und Monatsmittel berechnen (409 reason=disabled bei FX_AUTO_FETCH=0)",
    scope: "admin",
    response: apiDataResponseSchema(exchangeRateRefreshSchema),
    errors: [401, 403, 409, 429, 502],
  },
} satisfies Record<string, RouteSpec>;
