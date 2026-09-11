// ── Tags ─────────────────────────────────────────────────────────────────────────
/**
 * MCP-Werkzeuge fuer Tags (Phase 13d, Task 6) — dieselben Domain-Funktionen und
 * Zod-Schemas wie REST (/api/v1/Tag) und UI (/einstellungen/tags): listTags, saveTag,
 * deleteTag (src/domain/tag/manage.ts), tagDocument/untagDocument
 * (src/domain/tag/assign.ts). Tags sind reine Metadaten (kein GoBD-Belegbestandteil,
 * src/schemas/tag.ts) — setzen/entfernen ist auch an festgeschriebenen Rechnungen
 * erlaubt.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { dbInternal } from "@/lib/db";
import { listTags, saveTag, deleteTag, TagNotFoundError, TagNameConflictError } from "@/domain/tag/manage";
import { tagDocument, untagDocument } from "@/domain/tag/assign";
import { TagColor, TagDocType } from "@/schemas/tag";
import { NotFoundError } from "@/domain/errors";
import { ToolError, type McpToolsContext, type Result } from "./context";

/** Loest einen Tag per Name ODER Id auf (Muster resolveTemplate/resolveRecurring) —
 *  Tag-Namen sind je Organisation eindeutig (Tag.@@unique([orgId, name])), ein exakter
 *  Treffer ist also nie mehrdeutig; die Substring-Stufe bleibt fuer unvollstaendige
 *  Eingaben bestehen. */
async function resolveTag(orgId: string, ref: string) {
  const byId = await dbInternal.tag.findFirst({ where: { id: ref, orgId } });
  if (byId) return byId;
  const all = await dbInternal.tag.findMany({ where: { orgId } });
  const lower = ref.trim().toLowerCase();
  const exact = all.filter((t) => t.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const contains = all.filter((t) => t.name.toLowerCase().includes(lower));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) throw new ToolError(`Mehrere Tags passen zu "${ref}": ${contains.map((t) => t.name).join(", ")}. Bitte präzisieren.`);
  throw new ToolError(`Kein Tag "${ref}" gefunden. Mit list_tags die vorhandenen Tags anzeigen.`);
}

export function registerTagTools(server: McpServer, ctx: McpToolsContext): void {
  // ── list_tags ────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_tags",
    {
      title: "Tags auflisten",
      description: "Listet die Tags der Organisation auf (mit Zuordnungszahl).",
      inputSchema: {},
    },
    async (): Promise<Result> => {
      const org = await ctx.requireOrg();
      const rows = await listTags(org.id);
      if (rows.length === 0) return ctx.ok("Keine Tags.");
      return ctx.ok(JSON.stringify(rows.map((t) => ({ id: t.id, name: t.name, color: t.color, documentCount: t.documentCount })), null, 2));
    },
  );

  // ── create_tag ───────────────────────────────────────────────────────────────
  server.registerTool(
    "create_tag",
    {
      title: "Tag anlegen",
      description: "Legt einen neuen Tag an (Name je Organisation eindeutig, max. 40 Zeichen; Farbe aus acht festen Werten, Default slate).",
      inputSchema: { name: z.string().describe("Tag-Name"), color: TagColor.optional() },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const tag = await saveTag(org.id, null, { name: args.name, color: args.color });
        return ctx.ok(`Tag angelegt: "${tag.name}" (${tag.color}). ID: ${tag.id}.`);
      } catch (e) {
        if (e instanceof TagNameConflictError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── delete_tag ───────────────────────────────────────────────────────────────
  server.registerTool(
    "delete_tag",
    {
      title: "Tag löschen",
      description: "Löscht einen Tag (Name oder Id) samt aller seiner Zuordnungen — rührt keinen Beleg an (Tags sind Metadaten, kein ChangeLog-Eintrag).",
      inputSchema: { tag: z.string().describe("Tag-Name oder ID") },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const found = await resolveTag(org.id, args.tag);
        const result = await deleteTag(org.id, found.id, "mcp");
        return ctx.ok(`Tag "${found.name}" gelöscht (${result.removedAssignments} Zuordnung(en) entfernt).`);
      } catch (e) {
        if (e instanceof TagNotFoundError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── tag_document ─────────────────────────────────────────────────────────────
  server.registerTool(
    "tag_document",
    {
      title: "Tag einem Beleg zuordnen",
      description:
        "Ordnet einen Tag (Name oder Id) einem Beleg (Rechnung/Angebot-AB-Proforma/Lieferschein, per Belegnummer oder Id) zu — idempotent, auch an einer festgeschriebenen Rechnung erlaubt (Tags sind reine Metadaten, kein GoBD-Belegbestandteil).",
      inputSchema: {
        tag: z.string().describe("Tag-Name oder ID"),
        docType: TagDocType,
        docId: z.string().describe("Belegnummer oder ID"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const found = await resolveTag(org.id, args.tag);
        const doc = await ctx.resolveDocForAttachment(org.id, args.docType, args.docId);
        const result = await tagDocument(org.id, found.id, { docType: args.docType, docId: doc.id }, "mcp");
        return ctx.ok(result.created ? `Tag "${found.name}" zugeordnet.` : `Tag "${found.name}" war bereits zugeordnet.`);
      } catch (e) {
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );

  // ── untag_document ───────────────────────────────────────────────────────────
  server.registerTool(
    "untag_document",
    {
      title: "Tag-Zuordnung von einem Beleg entfernen",
      description: "Entfernt die Zuordnung eines Tags (Name oder Id) von einem Beleg (per Belegnummer oder Id) — idempotent, kein Fehler, wenn keine Zuordnung bestand.",
      inputSchema: {
        tag: z.string().describe("Tag-Name oder ID"),
        docType: TagDocType,
        docId: z.string().describe("Belegnummer oder ID"),
      },
    },
    async (args): Promise<Result> => {
      try {
        const org = await ctx.requireOrg();
        const found = await resolveTag(org.id, args.tag);
        const doc = await ctx.resolveDocForAttachment(org.id, args.docType, args.docId);
        const result = await untagDocument(org.id, found.id, { docType: args.docType, docId: doc.id }, "mcp");
        return ctx.ok(result.removed ? `Tag "${found.name}" entfernt.` : `Tag "${found.name}" war nicht zugeordnet.`);
      } catch (e) {
        if (e instanceof NotFoundError) return ctx.fail(e.message);
        if (e instanceof ToolError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );
}
