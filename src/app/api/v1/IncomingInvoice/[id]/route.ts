/** GET /api/v1/IncomingInvoice/{id} — Kopf, Lesefassung und letztes Prüfergebnis (ohne Dateipfade; IBAN maskiert). */
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { incomingDetailSchema, serializeIncomingDetail } from "@/api/serializers/incoming";
import { withIncomingErrors } from "@/api/incoming-errors";
import { getIncomingInvoiceDetail } from "@/domain/incoming/list";
import { updateIncomingInvoice } from "@/domain/incoming/update";
import { incomingPatchSchema } from "@/schemas/incoming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  return apiData(serializeIncomingDetail(await getIncomingInvoiceDetail(ctx.orgId, ctx.params.id, { ibanMode: "masked" })));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>((_req, ctx) =>
  withIncomingErrors(async () => {
    await updateIncomingInvoice(ctx.orgId, ctx.params.id, incomingPatchSchema.parse(ctx.body), ctx.actor);
    return apiData(serializeIncomingDetail(await getIncomingInvoiceDetail(ctx.orgId, ctx.params.id, { ibanMode: "masked" })));
  }),
{ scope: "write" });

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
  patch: {
    path: "/api/v1/IncomingInvoice/{id}",
    method: "PATCH",
    summary: "Eingangsrechnung bearbeiten: Kontakt zuordnen, interne Notiz, Kopfdaten von Hand (nur wenn die Datei keine liefert)",
    scope: "write",
    request: { body: incomingPatchSchema },
    response: apiDataResponseSchema(incomingDetailSchema),
    errors: [400, 401, 403, 404, 409, 422, 429, 500],
    errorNotes: {
      409: "STATUS_LOCKED (Zuordnung/Kopfdaten nur bei NEW und CHECKED) oder STATUS_CONFLICT; fachlicher Code in error.reason.",
      422: "CONTACT_NOT_FOUND (Kontakt nicht gefunden) oder MANUAL_NOT_ALLOWED (die Datei enthaelt bereits Kopfdaten).",
    },
  },
} satisfies Record<string, RouteSpec>;
