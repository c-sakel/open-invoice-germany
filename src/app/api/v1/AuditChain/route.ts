/**
 * GET /api/v1/AuditChain — Historie der Hash-Ketten-Pruefungen (Phase 16a), neueste zuerst.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { listChainVerifications } from "@/domain/audit/verify-chain";
import { auditChainListQuerySchema } from "@/schemas/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const { limit } = auditChainListQuerySchema.parse(Object.fromEntries(searchParams));
  return apiData(await listChainVerifications(ctx.orgId, limit));
}, { scope: "read" });

export const spec = {
  list: {
    path: "/api/v1/AuditChain",
    method: "GET",
    summary: "Historie der Hash-Ketten-Pruefungen des Aenderungsprotokolls (neueste zuerst)",
    scope: "read",
    request: { query: auditChainListQuerySchema },
    response: apiDataResponseSchema(z.array(z.unknown())),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
