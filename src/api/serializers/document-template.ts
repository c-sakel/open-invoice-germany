/**
 * Serialisierer fuer `/api/v1/DocumentTemplate` (Phase 13d, Task 5, Muster
 * src/api/serializers/text-template.ts). `payloadJson` wird NIE roh ausgeliefert —
 * `documentTemplatePayloadSchema.parse(JSON.parse(...))` laeuft hier ERNEUT (Schema-
 * Drift-sicher, koordinator-nachtrag.md, dasselbe Muster wie `applyTemplate`,
 * src/domain/template/apply.ts), nicht dem gespeicherten JSON vertraut.
 *
 * `payload` im OpenAPI-Schema unten ist bewusst `z.record(...)` statt einer vollen
 * Feldliste (Muster `RESOURCE_SCHEMAS.Settings` in src/api/openapi.ts) — eine
 * vollstaendige Kopie von `documentTemplatePayloadSchema` (18 Felder + Zeilen) wuerde
 * hier UNABHAENGIG von der eigentlichen Validierung altern; die tatsaechliche
 * Validierung laeuft ausschliesslich ueber `documentTemplatePayloadSchema` selbst
 * (src/schemas/template.ts), nie ueber dieses rein dokumentarische Antwortschema.
 */
import "../openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { iso } from "./common";
import type { DocumentTemplate } from "@/generated/prisma/client";
import { documentTemplatePayloadSchema } from "@/schemas/template";
import { z } from "zod";

export function serializeDocumentTemplate(t: DocumentTemplate) {
  return {
    objectName: "DocumentTemplate" as const,
    id: t.id,
    name: t.name,
    docType: t.docType,
    kind: t.kind,
    customerId: t.customerId,
    payload: documentTemplatePayloadSchema.parse(JSON.parse(t.payloadJson)),
    usageCount: t.usageCount,
    lastUsedAt: iso(t.lastUsedAt),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

/** OpenAPI-Response-Schema (Phase 13d, Task 5) — aus serializeDocumentTemplate abgeleitet. */
export const documentTemplateSchema = z.object({
  objectName: z.literal("DocumentTemplate"),
  id: z.string(),
  name: z.string(),
  docType: z.string(),
  kind: z.string().nullable(),
  customerId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  usageCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
