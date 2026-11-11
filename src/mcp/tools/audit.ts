// ── Audit (Phase 16a) ──────────────────────────────────────────────────────────
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { auditChainVerifyInputSchema } from "@/schemas/audit";
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
}
