// ── CSV-Export ───────────────────────────────────────────────────────────────────
/**
 * MCP-Werkzeug `export_csv` (Phase 18b, Task 3) — dieselbe Domainfunktion wie REST
 * (`GET /api/v1/<Ressource>?format=csv`): `exportFromApiFilter`. Rueckgabe ohne BOM.
 * (T6 ergaenzt hier den Import.)
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { exportFromApiFilter, ExportTooLargeError } from "@/domain/export";
import { RateLimitError } from "@/lib/rate-limit";
import type { McpToolsContext, Result } from "./context";

const EXPORT_RESOURCES = ["invoices", "quotes", "order-confirmations", "delivery-notes", "contacts", "products"] as const;

export function registerCsvTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "export_csv",
    {
      title: "CSV exportieren",
      description:
        "Exportiert Rechnungen (invoices), Angebote (quotes), Auftragsbestätigungen (order-confirmations), Lieferscheine (delivery-notes), Kunden (contacts) oder Produkte (products) als CSV " +
        "(Semikolon, CRLF, deutsche Zahlen, ohne BOM). `filter` wie bei den list_*-Werkzeugen (z. B. status, from, to, customerId, search); keine Paginierung, höchstens 20.000 Zeilen. " +
        "Interne Notizen sind nie enthalten.",
      inputSchema: {
        resource: z.enum(EXPORT_RESOURCES).describe("Welche Liste exportiert wird"),
        filter: z.record(z.string(), z.unknown()).optional().describe("Listenfilter wie bei list_* (optional)"),
      },
    },
    async ({ resource, filter }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const raw: Record<string, unknown> = { ...(filter ?? {}) };
        for (const k of ["format", "embed", "limit", "offset"]) delete raw[k];
        const result = await exportFromApiFilter(org.id, resource, raw);
        return ctx.ok(result.csv);
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Ungültiger Filter: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof ExportTooLargeError) return ctx.fail(e.message);
        if (e instanceof RateLimitError) return ctx.fail("Zu viele Exporte — bitte kurz warten.");
        return ctx.failUnknown(e);
      }
    },
  );
}
