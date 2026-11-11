// ── Audit (Phase 16a) ──────────────────────────────────────────────────────────
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { AuditExportPendingError, AuditExportTooLargeError, buildAuditExportFile, removeAuditExportFile } from "@/domain/audit/export";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { auditChainVerifyInputSchema, auditExportQuerySchema, auditExportRange } from "@/schemas/audit";
import { z } from "zod";
import { PROJECT_ROOT } from "../bootstrap";
import type { McpToolsContext, Result } from "./context";

export function registerAuditTools(server: McpServer, ctx: McpToolsContext): void {
  server.registerTool(
    "verify_audit_chain",
    {
      title: "Hash-Kette des Änderungsprotokolls prüfen",
      description:
        "Prüft die GoBD-Hash-Kette des Änderungsprotokolls der Organisation lückenlos, protokolliert die Prüfung und alarmiert bei einem Bruch. Liefert valid, entries, brokenEntryId, lastHash, durationMs, checkedAt.",
      inputSchema: auditChainVerifyInputSchema.shape,
    },
    async (args): Promise<Result> => {
      try {
        auditChainVerifyInputSchema.parse(args ?? {});
        const org = await ctx.requireOrg();
        return ctx.ok(JSON.stringify(await verifyOrgChain(org.id, "MCP"), null, 2));
      } catch (e) {
        return ctx.failUnknown(e);
      }
    },
  );

  const exportInput = z.object({
    from: z.string().describe("Beginn (JJJJ-MM-TT)"),
    to: z.string().describe("Ende inklusive (JJJJ-MM-TT), höchstens 3 Jahre nach Beginn"),
    outputDir: z.string().optional().describe("Zielverzeichnis (Default: <Projekt>/exports)"),
  });

  server.registerTool(
    "create_audit_export",
    {
      title: "Prüfer-Export (§ 147 Abs. 6 AO) erzeugen",
      description:
        "Schreibt den Prüfer-Export (ZIP mit CSV-Tabellen, index.xml, DTD, Kettenprüfung und archivierten Belegen PDF/XML) für den Zeitraum in eine Datei und gibt den Pfad zurück. Archiviert dabei noch nicht archivierte festgeschriebene Belege.",
      inputSchema: exportInput.shape,
    },
    async (args): Promise<Result> => {
      try {
        const input = exportInput.parse(args);
        const q = auditExportQuerySchema.parse({ from: input.from, to: input.to });
        const org = await ctx.requireOrg();
        const built = await buildAuditExportFile(org.id, auditExportRange(q));
        try {
          const dir = input.outputDir ? path.resolve(input.outputDir) : path.join(PROJECT_ROOT, "exports");
          mkdirSync(dir, { recursive: true });
          const target = path.join(dir, `pruefer-export-${q.from}-${q.to}.zip`);
          copyFileSync(built.path, target);
          return ctx.ok(`Prüfer-Export geschrieben: ${target}\nBelege: ${built.invoices}`);
        } finally {
          await removeAuditExportFile(built.path);
        }
      } catch (e) {
        if (e instanceof z.ZodError) return ctx.fail(e.issues.map((x) => x.message).join("; "));
        if (e instanceof AuditExportTooLargeError || e instanceof AuditExportPendingError) return ctx.fail(e.message);
        return ctx.failUnknown(e);
      }
    },
  );
}
