/**
 * Lesende Vorlagen-Abfragen (Phase 13d, Task 3): Vorlagenliste einer Organisation,
 * optional nach docType gefiltert (Belegliste "Aus Vorlage erzeugen"-Menue).
 */
import { dbInternal } from "@/lib/db";
import type { TagDocType } from "@/schemas/tag";

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
