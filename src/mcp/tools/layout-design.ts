/**
 * MCP-Werkzeuge fuer Layout-Designs (Phase 16g) — dieselben Domain-Funktionen und Zod-Schemas
 * wie REST (/api/v1/Layout): listLayoutDesigns, saveLayoutDesign/archiveLayoutDesign,
 * renderLayoutPreview.
 */
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PROJECT_ROOT } from "../bootstrap";
import { InvalidOperationError, NotFoundError, ValidationError } from "@/domain/errors";
import { listLayoutDesigns } from "@/domain/layout-design/list";
import { saveLayoutDesign, updateLayoutDesign, layoutDesignSaveSchema } from "@/domain/layout-design/save";
import { layoutPreviewSchema, renderLayoutPreview } from "@/domain/layout-design/preview";
import { serializeLayoutDesign } from "@/api/serializers/layout";
import { ToolError, type McpToolsContext, type Result } from "./context";

function failFrom(ctx: McpToolsContext, e: unknown): Result {
  if (e instanceof z.ZodError) return ctx.fail(`Validierung fehlgeschlagen: ${e.issues.map((i) => i.message).join("; ")}`);
  if (e instanceof ValidationError || e instanceof NotFoundError || e instanceof InvalidOperationError || e instanceof ToolError) return ctx.fail(e.message);
  return ctx.failUnknown(e);
}

export function registerLayoutDesignTools(server: McpServer, ctx: McpToolsContext): void {
  // ── list_layout_designs ──────────────────────────────────────────────────────
  server.registerTool(
    "list_layout_designs",
    {
      title: "Layout-Designs auflisten",
      description: "Listet die Layout-Designs der Organisation (id, ref `design:<id>`, name, baseLayoutId, currentVersion, archived). Die sieben festen Vorlagen kommen ueber list_pdf_layouts.",
      inputSchema: { includeArchived: z.boolean().optional().describe("Archivierte Designs einschliessen (Default: nein)") },
    },
    async ({ includeArchived }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const rows = await listLayoutDesigns(org.id, { includeArchived: includeArchived ?? false });
        return ctx.ok(JSON.stringify(rows.map((d) => serializeLayoutDesign(d)), null, 2));
      } catch (e) {
        return failFrom(ctx, e);
      }
    },
  );

  // ── save_layout_design ───────────────────────────────────────────────────────
  server.registerTool(
    "save_layout_design",
    {
      title: "Layout-Design speichern",
      description:
        "Legt ein Layout-Design an (ohne id) oder aendert es (mit id): `config` (version 1) erzeugt bei Aenderung eine neue, unveraenderliche Version; ohne `config` beim Anlegen gilt die Startvorlage `baseLayoutId`. `archived` archiviert/reaktiviert (zugeordnete Designs lassen sich nicht archivieren). Pflichtbloecke und -spalten sind nicht abschaltbar. Zuordnung zu Belegtypen ueber update_branding_settings {layoutId/layoutByType: \"design:<id>\"}.",
      inputSchema: { ...layoutDesignSaveSchema.shape, archived: z.boolean().optional() },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const { archived, ...rest } = args;
        const input = layoutDesignSaveSchema.parse(rest);
        // Mit id: Archivstatus zuerst (scheitert er, wird nichts gespeichert) — wie PUT /api/v1/Layout/{id}.
        const saved = input.id
          ? await updateLayoutDesign(org.id, input.id, { name: input.name, config: input.config, archived }, "mcp")
          : await saveLayoutDesign(org.id, input, "mcp");
        return ctx.ok(JSON.stringify(serializeLayoutDesign(saved, true), null, 2));
      } catch (e) {
        return failFrom(ctx, e);
      }
    },
  );

  // ── preview_layout_design ────────────────────────────────────────────────────
  server.registerTool(
    "preview_layout_design",
    {
      title: "Layout-Design als Vorschau-PDF exportieren",
      description:
        "Rendert ein Vorschau-PDF (Wasserzeichen VORSCHAU) mit Musterbeleg oder einer Entwurfsrechnung (`draftInvoiceId`) und schreibt es als layout-vorschau-<id|neu>.pdf nach exports/ (oder outputDir). `config` (ungespeichert) und `version` schliessen sich aus; ohne beides gilt die aktuelle Version des Designs `id`. Ohne `id` ist `config` Pflicht.",
      inputSchema: { id: z.string().optional().describe("Design-ID"), ...layoutPreviewSchema.shape, outputDir: z.string().optional().describe("Zielverzeichnis (Default: <Projekt>/exports)") },
    },
    async ({ id, outputDir, ...preview }): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const pdf = await renderLayoutPreview(org.id, id ?? null, preview);
        const dir = outputDir ? path.resolve(outputDir) : path.join(PROJECT_ROOT, "exports");
        mkdirSync(dir, { recursive: true });
        const base = (id ?? "neu").replace(/[^A-Za-z0-9._-]/g, "_");
        const file = path.join(dir, `layout-vorschau-${base}.pdf`);
        writeFileSync(file, pdf);
        return ctx.ok(`Vorschau geschrieben: ${file}`);
      } catch (e) {
        return failFrom(ctx, e);
      }
    },
  );
}
