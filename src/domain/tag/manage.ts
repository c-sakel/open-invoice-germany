/**
 * Tag-Verwaltung (Phase 13d, Task 2): auflisten (mit Zuordnungszahl), anlegen/aendern,
 * loeschen. Tags sind reine Metadaten (kein GoBD-Belegbestandteil, src/schemas/tag.ts) —
 * Loeschen entfernt ihre Zuordnungen per DB-Cascade (prisma/migrations/
 * 20260913092000_phase13d_tags, DocumentTag.tagId ON DELETE CASCADE), ruehrt dabei aber
 * keinen Beleg an.
 *
 * Muster: src/domain/payment-method/manage.ts (eigene Fehlerklasse statt rohem
 * P2002-Text, dbInternal.$transaction). Org-Isolation in jeder Abfrage.
 */
import { Prisma } from "@/generated/prisma/client";
import type { Tag } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { tagInputSchema } from "@/schemas/tag";

export class TagNotFoundError extends Error {}
/** orgId/name ist eindeutig — statt des rohen Prisma-P2002-Fehlertexts eine fuer
 *  Anwender verstaendliche Meldung. */
export class TagNameConflictError extends Error {}

/** Ein Tag mit der Anzahl der Belege, denen er aktuell zugeordnet ist. */
export interface TagRow {
  id: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
  documentCount: number;
}

/** Listet die Tags einer Organisation (alphabetisch), je Tag mit der Zuordnungszahl. */
export async function listTags(orgId: string): Promise<TagRow[]> {
  const rows = await dbInternal.tag.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true, createdAt: true, updatedAt: true, _count: { select: { documents: true } } },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, color: r.color, createdAt: r.createdAt, updatedAt: r.updatedAt, documentCount: r._count.documents }));
}

/**
 * Legt einen Tag an (kein `id`) oder aendert Name/Farbe (`id` gesetzt). Der Name ist je
 * Organisation eindeutig (Tag.@@unique([orgId, name])) — ein doppelter Name wirft
 * `TagNameConflictError` statt des rohen Prisma-Fehlers.
 */
export async function saveTag(orgId: string, id: string | null, rawInput: unknown): Promise<Tag> {
  const input = tagInputSchema.parse(rawInput);

  try {
    return await dbInternal.$transaction(async (tx) => {
      if (id) {
        const existing = await tx.tag.findFirst({ where: { id, orgId } });
        if (!existing) throw new TagNotFoundError("Tag nicht gefunden.");
        return tx.tag.update({ where: { id: existing.id }, data: { name: input.name, color: input.color } });
      }
      return tx.tag.create({ data: { orgId, name: input.name, color: input.color } });
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new TagNameConflictError("Es gibt bereits einen Tag mit diesem Namen.");
    }
    throw e;
  }
}

/**
 * Loescht einen Tag. Seine Zuordnungen (DocumentTag) werden per DB-Cascade automatisch
 * entfernt — kein Beleg wird dabei veraendert, kein ChangeLog-Eintrag (Tags sind
 * Metadaten). Rueckgabe: Anzahl der entfernten Zuordnungen (Bestaetigungsmeldung UI).
 */
export async function deleteTag(orgId: string, id: string): Promise<{ removedAssignments: number }> {
  return dbInternal.$transaction(async (tx) => {
    const tag = await tx.tag.findFirst({ where: { id, orgId } });
    if (!tag) throw new TagNotFoundError("Tag nicht gefunden.");
    const removedAssignments = await tx.documentTag.count({ where: { orgId, tagId: id } });
    await tx.tag.delete({ where: { id: tag.id } });
    return { removedAssignments };
  });
}
