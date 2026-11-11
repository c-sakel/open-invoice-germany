/**
 * GET /api/v1/AuditExport?from&to — Pruefer-Export nach § 147 Abs. 6 AO (Phase 16a) als ZIP
 * (CSV + index.xml + archivierte Belege). Scope `admin`.
 */
import { withApi } from "@/api/auth";
import { auditExportResponse } from "@/api/audit-export-response";
import { type RouteSpec } from "@/api/spec";
import { auditExportQuerySchema } from "@/schemas/audit";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  return auditExportResponse(ctx.orgId, Object.fromEntries(new URL(req.url).searchParams));
}, { scope: "admin" });

export const spec = {
  get: {
    path: "/api/v1/AuditExport",
    method: "GET",
    summary: "Pruefer-Export (ZIP) fuer einen Zeitraum von hoechstens drei Jahren",
    scope: "admin",
    request: { query: auditExportQuerySchema },
    // ZIP-Bytes statt {data}-Umschlag.
    response: z.unknown(),
    errors: [400, 401, 403, 413, 429],
  },
} satisfies Record<string, RouteSpec>;
