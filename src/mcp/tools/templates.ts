// ── Belegvorlagen ────────────────────────────────────────────────────────────────
/**
 * MCP-Werkzeuge fuer Belegvorlagen (Phase 13d, Task 6) — dieselben Domain-Funktionen und
 * Zod-Schemas wie REST (/api/v1/DocumentTemplate) und UI (/vorlagen): listTemplates,
 * saveTemplateFromDocument, applyTemplate (src/domain/template/{list,save,apply}.ts).
 * Kein direktes Anlegen OHNE Quellbeleg hier (anders als REST `createTemplate`) — die UI
 * kennt ebenfalls nur "aus einem gespeicherten Beleg speichern", kein zusaetzlicher
 * MCP-only-Pfad.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { dbInternal } from "@/lib/db";
import { listTemplates } from "@/domain/template/list";
import { saveTemplateFromDocument, TemplateNameConflictError } from "@/domain/template/save";
import { applyTemplate, TemplateCustomerRequiredError } from "@/domain/template/apply";
import { TaxRateNotAllowedError } from "@/domain/settings/tax-rates";
import { NotFoundError } from "@/domain/errors";
import { TagDocType } from "@/schemas/tag";
import { ToolError, type McpToolsContext, type Result } from "./context";

/** Loest eine Vorlage per Name ODER Id auf (Muster resolveRecurring, src/mcp/tools/
 *  context.ts) — Vorlagennamen sind je Organisation eindeutig
 *  (DocumentTemplate.@@unique([orgId, name])), ein exakter Treffer ist also nie
 *  mehrdeutig; die Substring-Stufe bleibt fuer unvollstaendige Eingaben bestehen. */
async function resolveTemplate(orgId: string, ref: string) {
  const byId = await dbInternal.documentTemplate.findFirst({ where: { id: ref, orgId } });
  if (byId) return byId;
  const all = await dbInternal.documentTemplate.findMany({ where: { orgId } });
  const lower = ref.trim().toLowerCase();
  const exact = all.filter((t) => t.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const contains = all.filter((t) => t.name.toLowerCase().includes(lower));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1)
    throw new ToolError(`Mehrere Vorlagen passen zu "${ref}": ${contains.map((t) => t.name).join(", ")}. Bitte präzisieren.`);
  throw new ToolError(`Keine Vorlage "${ref}" gefunden. Mit list_templates die vorhandenen Vorlagen anzeigen.`);
}

export function registerTemplateTools(server: McpServer, ctx: McpToolsContext): void {
  // ── list_templates ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_templates",
    {
      title: "Belegvorlagen auflisten",
      description: "Listet die Belegvorlagen der Organisation, optional nach Belegtyp gefiltert (INVOICE/QUOTE/DELIVERY_NOTE).",
      inputSchema: { docType: TagDocType.optional() },
    },
    async (args): Promise<Result> => {
      const org = await ctx.requireOrg();
      const rows = await listTemplates(org.id, args.docType);
      if (rows.length === 0) return ctx.ok("Keine Vorlagen.");
      return ctx.ok(
        JSON.stringify(
          rows.map((r) => ({
            id: r.id,
            name: r.name,
            docType: r.docType,
            kind: r.kind,
            customerId: r.customerId,
            usageCount: r.usageCount,
            lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
          })),
          null,
          2,
        ),
      );
    },
  );

  // ── create_template_from_document ───────────────────────────────────────────
  server.registerTool(
    "create_template_from_document",
    {
      title: "Vorlage aus einem Beleg speichern",
      description:
        "Speichert den aktuellen Stand eines GESPEICHERTEN Belegs (Rechnung/Angebot-AB-Proforma/Lieferschein, per Belegnummer oder Id) als wiederverwendbare Vorlage. Positionen + Kopf-Metadaten, OHNE Belegnummer/Datum/Snapshots/interne Notizen (§48) — eine Vorlage ist ein Schnappschuss und ändert sich nicht mit dem Ursprungsbeleg.",
      inputSchema: {
        docType: TagDocType,
        docId: z.string().describe("Belegnummer oder ID"),
        name: z.string().describe("Name der neuen Vorlage (je Organisation eindeutig)"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const doc = await ctx.resolveDocForAttachment(org.id, args.docType, args.docId);
        const tpl = await saveTemplateFromDocument(org.id, { docType: args.docType, docId: doc.id, name: args.name }, "mcp");
        return ctx.ok(`Vorlage "${tpl.name}" gespeichert. ID: ${tpl.id}.`);
      } catch (e) {
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        if (e instanceof TemplateNameConflictError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── apply_template ───────────────────────────────────────────────────────────
  server.registerTool(
    "apply_template",
    {
      title: "Beleg aus einer Vorlage erzeugen",
      description:
        "Erzeugt aus einer Vorlage (Name oder Id) einen neuen Belegentwurf — dieselbe Domain-Funktion wie /vorlagen (gleiche Steuersatz-/Kundenprüfung, kein Bypass). Optional ein Kunde (Name oder Id), falls die Vorlage noch keinen festlegt; ohne auflösbaren Kunden schlägt der Aufruf fehl.",
      inputSchema: {
        template: z.string().describe("Vorlagenname oder ID"),
        customer: z.string().optional().describe("Kundenname oder ID (ergänzt/überschreibt den Vorlagen-Kunden)"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const tpl = await resolveTemplate(org.id, args.template);
        const customer = args.customer ? await ctx.resolveCustomer(org.id, args.customer) : null;
        const { docType, id } = await applyTemplate(org.id, tpl.id, { customerId: customer?.id }, "mcp");
        return ctx.ok(`Entwurf aus Vorlage "${tpl.name}" erzeugt: ${docType} ${id}.`);
      } catch (e) {
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        if (e instanceof TemplateCustomerRequiredError) return ctx.fail(e.message);
        if (e instanceof TaxRateNotAllowedError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );
}
