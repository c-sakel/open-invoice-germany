/**
 * Lesende Vorlagen-Abfragen (Phase 13d, Task 3): Vorlagenliste einer Organisation,
 * optional nach docType gefiltert (Belegliste "Aus Vorlage erzeugen"-Menue).
 */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { TagDocType } from "@/schemas/tag";
import type { DocumentTemplate } from "@/generated/prisma/client";

export interface TemplateRow {
  id: string;
  name: string;
  docType: TagDocType;
  kind: string | null;
  customerId: string | null;
  usageCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Listet die Vorlagen einer Organisation (alphabetisch nach Name), optional auf einen
 *  docType eingeschraenkt. */
export async function listTemplates(orgId: string, docType?: TagDocType): Promise<TemplateRow[]> {
  const rows = await dbInternal.documentTemplate.findMany({
    where: { orgId, ...(docType ? { docType } : {}) },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      docType: true,
      kind: true,
      customerId: true,
      usageCount: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map((r) => ({ ...r, docType: r.docType as TagDocType }));
}

/**
 * Paginierte Listenfunktion fuer `GET /api/v1/DocumentTemplate` (Phase 13d, Task 5,
 * Muster src/domain/text-template/list.ts#listTextTemplatesApi) — liefert die
 * VOLLSTAENDIGEN Prisma-Zeilen (inkl. `payloadJson`, siehe serializeDocumentTemplate,
 * src/api/serializers/document-template.ts), anders als `listTemplates` oben, das fuer
 * die UI-Liste bewusst nur Metadaten selektiert.
 */
export const templateListApiFilterSchema = z.object({
  docType: TagDocType.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TemplateListApiFilter = z.infer<typeof templateListApiFilterSchema>;

export interface TemplateListApiResult {
  rows: DocumentTemplate[];
  total: number;
  limit: number;
  offset: number;
}

export async function listTemplatesApi(orgId: string, rawFilter: unknown): Promise<TemplateListApiResult> {
  const filter = templateListApiFilterSchema.parse(rawFilter);
  const where = { orgId, ...(filter.docType ? { docType: filter.docType } : {}) };
  const [total, rows] = await Promise.all([
    dbInternal.documentTemplate.count({ where }),
    dbInternal.documentTemplate.findMany({ where, orderBy: { name: "asc" }, skip: filter.offset, take: filter.limit }),
  ]);
  return { rows, total, limit: filter.limit, offset: filter.offset };
}
