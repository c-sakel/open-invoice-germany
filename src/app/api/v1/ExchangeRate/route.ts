/**
 * /api/v1/ExchangeRate — Wechselkurse (Phase 16b, Task 9; § 16 Abs. 6 UStG, Art. 230 MwStSystRL).
 * GET: der Kurs, der fuer Waehrung + Stichtag gemaess der Kursquelle der Organisation gilt
 * (`rateFor`, dieselbe Domain-Funktion wie beim Festschreiben); 404, wenn keiner vorliegt.
 * POST: Kurs manuell pflegen (`upsertManualRate`, Herkunft MANUAL, Ueberschreiben von Importen).
 * Die Kurstabelle ist instanzweit; das Pflegen wirkt daher auf alle Organisationen -> Scope `admin`.
 */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { exchangeRatePickSchema, exchangeRateSchema, serializeExchangeRate, serializeExchangeRatePick } from "@/api/serializers/exchange-rate";
import { NotFoundError } from "@/domain/errors";
import { rateFor } from "@/domain/fx/rate-for";
import { upsertManualRate } from "@/domain/fx/store";
import { exchangeRateQuerySchema, exchangeRateUpsertSchema } from "@/schemas/fx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const query = exchangeRateQuerySchema.parse(Object.fromEntries(searchParams));
  const pick = await rateFor(ctx.orgId, query.currency, query.date);
  if (!pick) throw new NotFoundError(`Kein Kurs fuer ${query.currency} zum ${query.date.toISOString().slice(0, 10)} vorhanden.`);
  return apiData(serializeExchangeRatePick(query.currency, pick));
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  const input = exchangeRateUpsertSchema.parse(ctx.body);
  const row = await upsertManualRate(input, ctx.actor, ctx.orgId);
  return apiData(serializeExchangeRate(row), 201);
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/ExchangeRate",
    method: "GET",
    summary: "Kurs fuer Waehrung und Stichtag gemaess Kursquelle der Organisation (404 ohne Kurs)",
    scope: "read",
    request: { query: exchangeRateQuerySchema },
    response: apiDataResponseSchema(exchangeRatePickSchema),
    errors: [400, 401, 403, 404, 429],
  },
  create: {
    path: "/api/v1/ExchangeRate",
    method: "POST",
    summary: "Kurs manuell pflegen (Tageskurs ECB oder Monatsdurchschnitt MONTHLY, Upsert)",
    scope: "admin",
    request: { body: exchangeRateUpsertSchema },
    response: apiDataResponseSchema(exchangeRateSchema),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
