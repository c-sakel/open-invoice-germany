/**
 * Serialisierer fuer `/api/v1/ExchangeRate` (Phase 16b, Task 9): Kurse als Dezimalstring
 * (Einheiten Fremdwaehrung je 1 EUR, Punkt als Trenner, 4-6 Nachkommastellen), Datum als
 * `YYYY-MM-DD`. Intern bleibt der Kurs Integer-Micros (`formatRate`).
 */
import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { formatRate } from "@/domain/fx/decimal";
import type { ExchangeRateRow } from "@/domain/fx/store";
import type { FxPick } from "@/domain/fx/pick-rate";
import { iso } from "./common";

export function serializeExchangeRate(r: ExchangeRateRow) {
  return {
    objectName: "ExchangeRate" as const,
    id: r.id,
    source: r.source,
    currency: r.currency,
    rateDate: r.rateDate.toISOString().slice(0, 10),
    rate: formatRate(r.rateMicros, "en-GB"),
    origin: r.origin,
    note: r.note,
    fetchedAt: iso(r.fetchedAt),
  };
}

/** Ergebnis der Kurswahl (`rateFor`): der Kurs, der fuer den Stichtag gelten wuerde. */
export function serializeExchangeRatePick(currency: string, pick: FxPick) {
  return {
    currency,
    rate: formatRate(pick.rateMicros, "en-GB"),
    rateDate: pick.rateDate.toISOString().slice(0, 10),
    source: pick.source,
  };
}

export const exchangeRateSchema = z.object({
  objectName: z.literal("ExchangeRate"),
  id: z.string(),
  source: z.enum(["ECB", "MONTHLY"]).describe("ECB = Tageskurs, MONTHLY = Monatsdurchschnitt (rateDate = Monatserster)"),
  currency: z.string(),
  rateDate: z.string(),
  rate: z.string().describe("Einheiten Fremdwaehrung je 1 EUR, z. B. 1.1214"),
  origin: z.string().describe("COMPUTED | IMPORTED | MANUAL"),
  note: z.string().nullable(),
  fetchedAt: z.string().nullable(),
});

export const exchangeRatePickSchema = z.object({
  currency: z.string(),
  rate: z.string().describe("Einheiten Fremdwaehrung je 1 EUR, z. B. 1.1214"),
  rateDate: z.string(),
  source: z.enum(["BMF_MONTHLY", "ECB_DAILY"]),
});

export const exchangeRateRefreshSchema = z.object({
  inserted: z.number().int(),
  months: z.number().int(),
  skippedCurrencies: z.array(z.string()),
  incompleteMonths: z.array(z.string()),
});
