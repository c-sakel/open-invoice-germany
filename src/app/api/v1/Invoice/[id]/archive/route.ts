/**
 * GET /api/v1/Invoice/{id}/archive — Archivstand einer Rechnung (Phase 16a): Art, SHA-256,
 * Quelle und Zeitpunkt je archiviertem Dokument, nie ein Dateipfad. Archiviert nicht selbst.
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { getInvoiceArchiveInfo } from "@/domain/invoice/archive-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const archiveSchema = z.object({
  archived: z.boolean(),
  documents: z.array(z.object({ kind: z.enum(["PDF", "CII", "UBL"]), sha256: z.string(), source: z.string(), createdAt: z.string() })),
});

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const info = await getInvoiceArchiveInfo(ctx.orgId, ctx.params.id);
  return apiData({ archived: info.archived, documents: info.documents.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })) });
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/Invoice/{id}/archive",
    method: "GET",
    summary: "Archivstand einer Rechnung (Art, SHA-256, Quelle, Zeitpunkt)",
    scope: "read",
    response: apiDataResponseSchema(archiveSchema),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
