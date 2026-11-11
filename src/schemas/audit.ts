import { z } from "zod";

/** Phase 16a: Kettenpruefung ohne Eingabe (POST /api/v1/AuditChain/verify, MCP verify_audit_chain). */
export const auditChainVerifyInputSchema = z.object({}).strict();

export const auditChainListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type AuditChainListQuery = z.infer<typeof auditChainListQuerySchema>;
