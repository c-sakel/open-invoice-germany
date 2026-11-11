// ── Wechselkurse (Phase 16b, Task 9; § 16 Abs. 6 UStG, Art. 230 MwStSystRL) ──────────────────
// Dieselben Zod-Schemas und Domain-Funktionen wie /api/v1/ExchangeRate (Kurswahl `rateFor`,
// Pflege `upsertManualRate`, Abruf `refreshExchangeRates`) — keine zweite Validierung.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { serializeExchangeRate, serializeExchangeRatePick } from "@/api/serializers/exchange-rate";
import { rateFor } from "@/domain/fx/rate-for";
import { refreshExchangeRates, upsertManualRate } from "@/domain/fx/store";
import { exchangeRateQuerySchema, exchangeRateUpsertSchema } from "@/schemas/fx";
import { ToolError, type McpToolsContext, type Result } from "./context";

export function registerFxTools(server: McpServer, ctx: McpToolsContext): void {
  // ── get_exchange_rate ────────────────────────────────────────────────────────
  server.registerTool(
    "get_exchange_rate",
    {
      title: "Wechselkurs abrufen",
      description:
        "Liefert den Kurs (Einheiten Fremdwaehrung je 1 EUR), der fuer Waehrung und Stichtag gemaess der Kursquelle der Organisation gilt (BMF_MONTHLY = amtlicher Monatsdurchschnitt, ECB_DAILY = EZB-Tageskurs). Ohne vorhandenen Kurs kommt ein Fehler — dann mit set_exchange_rate pflegen.",
      inputSchema: exchangeRateQuerySchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        // `args` hat das SDK bereits mit exchangeRateQuerySchema.shape geparst (Datum -> Date).
        const query: z.output<typeof exchangeRateQuerySchema> = args;
        const pick = await rateFor(org.id, query.currency, query.date);
        if (!pick) return ctx.fail(`Kein Kurs fuer ${query.currency} zum ${query.date.toISOString().slice(0, 10)} vorhanden.`);
        return ctx.ok(JSON.stringify(serializeExchangeRatePick(query.currency, pick), null, 2));
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── set_exchange_rate ────────────────────────────────────────────────────────
  server.registerTool(
    "set_exchange_rate",
    {
      title: "Wechselkurs pflegen",
      description:
        "Pflegt einen Kurs manuell (Upsert, Herkunft MANUAL, ueberschreibt Importe): source ECB = Tageskurs, MONTHLY = amtlicher Monatsdurchschnitt (rateDate dann der Monatserste, z. B. 2112-03-01). rate als Dezimalzahl, z. B. \"1,1214\" (Einheiten Fremdwaehrung je 1 EUR, hoechstens 6 Nachkommastellen). Wirkt nur auf Belege, die danach festgeschrieben werden.",
      inputSchema: exchangeRateUpsertSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        // `args` hat das SDK bereits mit exchangeRateUpsertSchema.shape geparst (rate -> Micros, Datum -> Date).
        const input: z.output<typeof exchangeRateUpsertSchema> = args;
        const row = await upsertManualRate(input, "mcp", org.id);
        return ctx.ok(`Kurs gespeichert: ${JSON.stringify(serializeExchangeRate(row))}`);
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof RangeError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── refresh_exchange_rates ───────────────────────────────────────────────────
  server.registerTool(
    "refresh_exchange_rates",
    {
      title: "EZB-Kurse abrufen",
      description:
        "Ruft die EZB-Referenzkurse sofort ab und berechnet das Monatsmittel des Vormonats (gepflegte Kurse bleiben unveraendert). Ergebnis: { inserted, months, skippedCurrencies, incompleteMonths }. Bei FX_AUTO_FETCH=0 ist der Abruf abgeschaltet.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        await ctx.requireOrg();
        if (process.env.FX_AUTO_FETCH === "0") return ctx.fail("Der automatische Kursabruf ist abgeschaltet (FX_AUTO_FETCH=0).");
        const result = await refreshExchangeRates(new Date());
        return ctx.ok(JSON.stringify(result, null, 2));
      } catch (e) {
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );
}
