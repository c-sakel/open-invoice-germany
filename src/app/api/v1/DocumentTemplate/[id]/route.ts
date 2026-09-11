/**
 * /api/v1/DocumentTemplate/{id} — einzelne Belegvorlage (Phase 13d, Task 5, Muster
 * src/app/api/v1/TextTemplate/[id]/route.ts). `PATCH` deckt Name/Kunde/Payload ab
 * (`updateTemplate`, src/domain/template/save.ts — `docType`/`kind` sind nicht Teil des
 * Update-Schemas, siehe dessen Modulkommentar). `DELETE` ist bodylos und ruehrt keinen
 * mit der Vorlage bereits erzeugten Beleg an (`deleteTemplate`).
 */
import { z } from "zod";
import { withApi } from "@/api/auth";
import { apiData } from "@/api/response";
import { apiDataResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeDocumentTemplate, documentTemplateSchema } from "@/api/serializers/document-template";
import { updateTemplate, deleteTemplate, TemplateNameConflictError } from "@/domain/template/save";
import { documentTemplateUpdateSchema } from "@/schemas/template";
import { dbInternal } from "@/lib/db";
import { NotFoundError, InvalidOperationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi<{ id: string }>(async (_req, ctx) => {
  const row = await dbInternal.documentTemplate.findFirst({ where: { id: ctx.params.id, orgId: ctx.orgId } });
  if (!row) throw new NotFoundError("Vorlage nicht gefunden.");
  return apiData(serializeDocumentTemplate(row));
}, { scope: "read" });

export const PATCH = withApi<{ id: string }>(async (_req, ctx) => {
  try {
    // updateTemplate wirft bei einer fremden/unbekannten id bereits NotFoundError
    // direkt (Muster renameTemplate) — keine Uebersetzung noetig.
    const updated = await updateTemplate(ctx.orgId, ctx.params.id, ctx.body);
    return apiData(serializeDocumentTemplate(updated));
  } catch (e) {
    if (e instanceof TemplateNameConflictError) throw new InvalidOperationError(e.message);
    throw e;
  }
}, { scope: "write" });

export const DELETE = withApi<{ id: string }>(async (_req, ctx) => {
  // deleteTemplate wirft bei einer fremden/unbekannten id bereits NotFoundError direkt.
  await deleteTemplate(ctx.orgId, ctx.params.id, ctx.actor);
  return apiData({ deleted: true });
}, { scope: "write" });

export const spec = {
  get: {
    path: "/api/v1/DocumentTemplate/{id}",
    method: "GET",
    summary: "Belegvorlage abrufen",
    scope: "read",
    response: apiDataResponseSchema(documentTemplateSchema),
    errors: [401, 403, 404, 429],
  },
  update: {
    path: "/api/v1/DocumentTemplate/{id}",
    method: "PATCH",
    summary: "Belegvorlage aktualisieren (Name/Kunde/Payload)",
    scope: "write",
    request: { body: documentTemplateUpdateSchema },
    response: apiDataResponseSchema(documentTemplateSchema),
    errors: [400, 401, 403, 404, 409, 429],
  },
  remove: {
    path: "/api/v1/DocumentTemplate/{id}",
    method: "DELETE",
    summary: "Belegvorlage loeschen",
    scope: "write",
    response: apiDataResponseSchema(z.object({ deleted: z.boolean() })),
    errors: [401, 403, 404, 429],
  },
} satisfies Record<string, RouteSpec>;
