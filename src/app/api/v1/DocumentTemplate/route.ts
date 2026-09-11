/**
 * /api/v1/DocumentTemplate — Belegvorlagen (Phase 13d, Task 5, Muster
 * src/app/api/v1/TextTemplate/route.ts). `POST` legt eine Vorlage DIREKT an
 * (`createTemplate`, src/domain/template/save.ts) — anders als die UI (/vorlagen, nur
 * "aus einem gespeicherten Beleg speichern"), ein API-Konsument liefert Payload/Kunde
 * selbst (`documentTemplateInputSchema`, src/schemas/template.ts).
 */
import { withApi } from "@/api/auth";
import { apiData, apiList } from "@/api/response";
import { apiDataResponseSchema, apiListResponseSchema, type RouteSpec } from "@/api/spec";
import { serializeDocumentTemplate, documentTemplateSchema } from "@/api/serializers/document-template";
import { listTemplatesApi, templateListApiFilterSchema } from "@/domain/template/list";
import { createTemplate, TemplateNameConflictError } from "@/domain/template/save";
import { documentTemplateInputSchema } from "@/schemas/template";
import { InvalidOperationError } from "@/domain/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  const result = await listTemplatesApi(ctx.orgId, Object.fromEntries(searchParams));
  return apiList(result.rows.map(serializeDocumentTemplate), result);
}, { scope: "read" });

export const POST = withApi(async (_req, ctx) => {
  try {
    const created = await createTemplate(ctx.orgId, ctx.body, ctx.actor);
    return apiData(serializeDocumentTemplate(created), 201);
  } catch (e) {
    if (e instanceof TemplateNameConflictError) throw new InvalidOperationError(e.message);
    throw e;
  }
}, { scope: "write" });

export const spec = {
  list: {
    path: "/api/v1/DocumentTemplate",
    method: "GET",
    summary: "Belegvorlagen auflisten (Filter docType)",
    scope: "read",
    request: { query: templateListApiFilterSchema },
    response: apiListResponseSchema(documentTemplateSchema),
    errors: [400, 401, 403, 429],
  },
  create: {
    path: "/api/v1/DocumentTemplate",
    method: "POST",
    summary: "Belegvorlage anlegen",
    scope: "write",
    request: { body: documentTemplateInputSchema },
    response: apiDataResponseSchema(documentTemplateSchema),
    // 404: ein angegebener customerId gehoert nicht zur eigenen Organisation
    // (Review-Fund Task 6, createTemplate prueft jetzt gegen Customer.orgId).
    errors: [400, 401, 403, 404, 409, 429],
  },
} satisfies Record<string, RouteSpec>;
