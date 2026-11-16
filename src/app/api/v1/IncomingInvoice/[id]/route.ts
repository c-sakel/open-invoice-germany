/** GET /api/v1/IncomingInvoice/{id} — Kopf, Lesefassung und letztes Prüfergebnis (ohne Dateipfade; IBAN maskiert). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { incomingDetailSchema, serializeIncomingDetail } from "@/api/serializers/incoming";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializeIncomingDetail(await getIncomingInvoiceDetail(ctx.orgId, ctx.params.id, { ibanMode: "masked" })));
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/IncomingInvoice/{id}",
    method: "GET",
    summary: "Eingangsrechnung mit Lesefassung und letztem Prüfergebnis abrufen",
    scope: "read",
    response: apiDataResponseSchema(incomingDetailSchema),
    errors: [401, 403, 404, 429, 500],
    errorNotes: { 500: "Die Lesefassung wird nur nach erfolgreicher Hash-Prüfung der archivierten Datei ausgegeben." },
  },
} satisfies Record<string, RouteSpec>;
