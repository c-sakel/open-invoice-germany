// ── Kontoabruf (nur lesend) ──────────────────────────────────────────────────────
/**
 * MCP-Werkzeuge des Kontoabrufs — dieselben Domainfunktionen und Ergebnisobjekte wie REST. Nur Status und Protokoll;
 * Einrichtung, Freigabe und Abruf gibt es nur in der Oberfläche (jeder Bankdialog kann eine Freigabe auslösen).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { RateLimitError } from "@/lib/rate-limit";
import { loadBankFetchStatus, listBankFetchRuns } from "@/domain/bank-fetch/status";
import { serializeBankFetchRun, serializeBankFetchStatus } from "@/api/serializers/bank-fetch";
import type { McpToolsContext, Result } from "./context";

export function registerBankFetchTools(server: McpServer, ctx: McpToolsContext): void {
  const json = (v: unknown): Result => ctx.ok(JSON.stringify(v));

  server.registerTool(
    "get_bank_fetch_status",
    {
      title: "Status des Kontoabrufs",
      description:
        "Liefert den Status des automatischen Kontoabrufs: ob eine Produkt-ID hinterlegt ist, die Abrufstunde und die Bankzugänge mit Zustand, " +
        "maskierter Kennung, maskierten IBANs, letztem Abruf und Fehlercode sowie der Frist für die nächste Freigabe. " +
        "Zugangsdaten, Adresse und Produkt-ID werden nie ausgegeben; Einrichtung und Abruf gibt es nur in der Oberfläche.",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        return json(serializeBankFetchStatus(await loadBankFetchStatus(org.id)));
      } catch (e) {
        if (e instanceof RateLimitError) return ctx.fail("Zu viele Anfragen — bitte kurz warten.");
        return ctx.failUnknown(e);
      }
    },
  );

  server.registerTool(
    "list_bank_fetch_runs",
    {
      title: "Abrufprotokoll des Kontoabrufs auflisten",
      description:
        "Listet das Abrufprotokoll je Konto (neueste zuerst): Ergebnis (fester Code), Zeitraum, Anzahl Dokumente und importierter Umsätze. " +
        "Filter `connectionId`. Mit `updatedSince` (ISO 8601 mit Zone, bezogen auf den Anlagezeitpunkt) und `cursor` aus `nextCursor` Abgleich in aufsteigender Reihenfolge. Keine Bankdaten, keine Banktexte.",
      inputSchema: {
        connectionId: z.string().max(64).optional(),
        updatedSince: z.string().optional(),
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const r = await listBankFetchRuns(org.id, args);
        return json({ data: r.items.map(serializeBankFetchRun), total: r.total, limit: r.limit, offset: r.offset, ...(r.nextCursor !== null ? { nextCursor: r.nextCursor } : {}) });
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Ungültige Eingabe: ${e.issues.map((i) => i.message).join("; ")}`);
        return ctx.failUnknown(e);
      }
    },
  );
}
