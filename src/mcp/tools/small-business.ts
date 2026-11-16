// ── Umsatzgrenzen der Kleinunternehmerregelung (§ 19 Abs. 1 UStG) ────────────────────────────
// Dieselbe Schema- und Domain-Funktion wie GET /api/v1/Report/smallBusiness — keine zweite Validierung.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { kuThreshold } from "@/domain/reporting/ku";
import { kuQuerySchema } from "@/schemas/small-business";
import { ToolError, type McpToolsContext, type Result } from "./context";
import { berlinYear } from "@/lib/berlin-time";

export function registerSmallBusinessTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "get_small_business_threshold",
    {
      title: "Umsatzgrenzen der Kleinunternehmerregelung auswerten",
      description:
        "Liefert vereinnahmten und berechneten Netto-Umsatz (EUR) des Jahres und des Vorjahres gegen die Grenzen von 25.000 EUR (Vorjahr bzw. laufendes Jahr nach § 19 Abs. 1 UStG) und 100.000 EUR (laufendes Jahr): level OK | WARN | NEXT_YEAR_LOST | EXCEEDED, reasons, applies (Kleinunternehmerregelung angewendet), Umsatz ausserhalb des Programms aus den Einstellungen und skippedWithoutEur (Fremdwaehrungsbelege ohne EUR-Wert). year optional (Standard: aktuelles Jahr). Hinweis zur Orientierung, keine steuerliche Beratung.",
      inputSchema: kuQuerySchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const query: z.output<typeof kuQuerySchema> = args;
        return ctx.ok(JSON.stringify(await kuThreshold(org.id, query.year ?? berlinYear(new Date())), null, 2));
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );
}
