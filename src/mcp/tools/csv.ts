// ── CSV-Export ───────────────────────────────────────────────────────────────────
/**
 * MCP-Werkzeug `export_csv` (Phase 18b, Task 3) — dieselbe Domainfunktion wie REST
 * (`GET /api/v1/<Ressource>?format=csv`): `exportFromApiFilter`. Rueckgabe ohne BOM.
 * Import (T6): `import_contacts`/`import_products` — dieselbe Domainfunktion und dasselbe Schema wie REST
 * (`importRequestSchema`); `dryRun` ist Standard `true`, die Vorschau enthaelt nie Beispielzeilen.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { exportFromApiFilter, ExportTooLargeError } from "@/domain/export";
import { RateLimitError } from "@/lib/rate-limit";
import { importRequestSchema, runCsvImport, ImportHashMismatchError, ImportRejectedError, type ImportResource } from "@/domain/import/run";
import { CsvFormatError, CsvLimitError } from "@/domain/import/parse-csv";
import type { McpToolsContext, Result } from "./context";

/** Eigene MCP-Grenze: Antworten gehen in den Modellkontext. */
export const MCP_EXPORT_ROW_LIMIT = 500;
const MCP_EXPORT_HINT = "Für größere Mengen REST (`?format=csv`) oder die Oberfläche nutzen.";

const EXPORT_RESOURCES = ["invoices", "quotes", "order-confirmations", "delivery-notes", "contacts", "products"] as const;

function importDescription(label: string): string {
  return (
    `Legt ${label} aus CSV-Text an (Semikolon oder Komma, Kopfzeile Pflicht; Spalten wie beim CSV-Export). ` +
    "`dryRun` ist standardmäßig true und liefert nur die Vorschau mit Fehlern je Zeile/Spalte; mit dryRun=false werden alle Zeilen angelegt oder keine " +
    "(nur Anlage, bestehende Datensätze werden nicht geändert). `expectedHash` (fileHash der Vorschau) ist beim Import (dryRun=false) Pflicht und bindet ihn an die geprüfte Datei. " +
    "Höchstens 2 MB und 2.000 Zeilen."
  );
}

export function registerCsvTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "export_csv",
    {
      title: "CSV exportieren",
      description:
        "Exportiert Rechnungen (invoices), Angebote (quotes), Auftragsbestätigungen (order-confirmations), Lieferscheine (delivery-notes), Kunden (contacts) oder Produkte (products) als CSV " +
        "(Semikolon, CRLF, deutsche Zahlen, ohne BOM). `filter` wie bei den list_*-Werkzeugen (z. B. status, from, to, customerId, search); keine Paginierung, höchstens 500 Zeilen (darüber Fehler; größere Mengen per REST `?format=csv` oder Oberfläche). " +
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
        const result = await exportFromApiFilter(org.id, resource, raw, { limit: MCP_EXPORT_ROW_LIMIT, hint: MCP_EXPORT_HINT });
        return ctx.ok(result.csv);
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(`Ungültiger Filter: ${e.issues.map((i) => i.message).join("; ")}`);
        if (e instanceof ExportTooLargeError) return ctx.fail(e.message);
        if (e instanceof RateLimitError) return ctx.fail("Zu viele Exporte — bitte kurz warten.");
        return ctx.failUnknown(e);
      }
    },
  );

  const importHandler = (resource: ImportResource) => async (args: z.infer<typeof importRequestSchema>): Promise<Result> => {
    try {
      const org = await ctx.requireOrg();
      const input = importRequestSchema.parse(args);
      if (!input.dryRun && !input.expectedHash) return ctx.fail("expectedHash (fileHash der Vorschau) ist beim Import Pflicht — zuerst die Vorschau (dryRun=true) abrufen.");
      const result = await runCsvImport(
        org.id,
        resource,
        { text: input.csv, fileName: input.fileName, dryRun: input.dryRun, expectedHash: input.expectedHash },
        { actor: "mcp", source: "MCP" },
      );
      return ctx.ok(JSON.stringify(result.status === "imported" ? { created: result.created, preview: result.preview } : { preview: result.preview }));
    } catch (e) {
      if (e instanceof ImportRejectedError) {
        const lines = e.preview.errors.slice(0, 20).map((r) => `Zeile ${r.line}${r.column ? `, ${r.column}` : ""}: ${r.message}`);
        return ctx.fail([`${e.message} ${e.preview.errorCount} Fehler.`, ...lines].join("\n"));
      }
      if (e instanceof z.ZodError) return ctx.fail(`Ungültige Eingabe: ${e.issues.map((i) => i.message).join("; ")}`);
      if (e instanceof CsvFormatError || e instanceof CsvLimitError || e instanceof ImportHashMismatchError) return ctx.fail(e.message);
      if (e instanceof RateLimitError) return ctx.fail("Zu viele Importe — bitte kurz warten.");
      return ctx.failUnknown(e);
    }
      };
  server.registerTool(
    "import_contacts",
    {
      title: "Kunden per CSV importieren",
      description: importDescription("Kunden"),
      inputSchema: importRequestSchema.shape,
    },
    importHandler("contacts"),
  );
  server.registerTool(
    "import_products",
    {
      title: "Produkte per CSV importieren",
      description: importDescription("Produkte"),
      inputSchema: importRequestSchema.shape,
    },
    importHandler("products"),
  );
}
