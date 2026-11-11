/**
 * POST /api/v1/AuditChain/verify — prueft die Hash-Kette des Aenderungsprotokolls sofort
 * (Phase 16a). Scope `admin`; protokolliert die Pruefung und alarmiert bei Bruch.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { auditChainVerifyInputSchema } from "@/schemas/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApi(async (_req, ctx) => {
  auditChainVerifyInputSchema.parse(ctx.body ?? {});
  return apiData(await verifyOrgChain(ctx.orgId, "API"));
}, { scope: "admin" });

export const spec = {
  create: {
    path: "/api/v1/AuditChain/verify",
    method: "POST",
    summary: "Hash-Kette des Aenderungsprotokolls jetzt pruefen",
    scope: "admin",
    request: { body: auditChainVerifyInputSchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
