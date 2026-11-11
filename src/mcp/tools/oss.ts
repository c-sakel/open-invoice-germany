// ── OSS-Schwelle (Phase 16e, § 3c Abs. 4 UStG) ───────────────────────────────────────────────
// Dieselbe Schema- und Domain-Funktion wie GET /api/v1/Report/oss — keine zweite Validierung.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ossThreshold } from "@/domain/reporting/oss";
import { ossQuerySchema } from "@/schemas/oss";
import { ToolError, type McpToolsContext, type Result } from "./context";

export function registerOssTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "get_oss_threshold",
    {
      title: "OSS-Schwelle auswerten",
      description:
        "Liefert den EU-B2C-Netto-Umsatz (Kaeufer in EU-Land ausser DE ohne USt-IdNr., in EUR) des Jahres und des Vorjahres gegen die Schwelle von 10.000 EUR (§ 3c Abs. 4 UStG): level OK | WARN | EXCEEDED, Summen je Land, Zaehlmodus (ALL_EU_B2C | BY_PRODUCT) und skippedWithoutEur (Altbelege ohne EUR-Betrag). year optional (Standard: aktuelles Jahr). Hinweis zur Orientierung, keine steuerliche Beratung.",
      inputSchema: ossQuerySchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const query: z.output<typeof ossQuerySchema> = args;
        return ctx.ok(JSON.stringify(await ossThreshold(org.id, query.year ?? new Date().getUTCFullYear()), null, 2));
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );
}
