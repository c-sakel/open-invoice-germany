/**
 * Lesende Tag-Abfragen (Phase 13d, Task 2): Tags je Beleg (Detailkarte/Listen, eine
 * Abfrage statt N+1) und Beleg-IDs je Tag (FilterBar-Filter `tag`, 13a-Nachtrag).
 */
import { dbInternal } from "@/lib/db";
import type { TagDocType } from "@/schemas/tag";
import type { TagRow } from "@/domain/tag/manage";

/** Deckelt docIdsForTag gegen unbegrenztes Laden bei sehr vielen Zuordnungen. */
export const TAG_FILTER_LIMIT = 10_000;

/**
 * Tags je Beleg fuer eine Menge von Beleg-IDs EINES docType. Leere `docIds` liefern eine
 * leere Map, ohne eine Abfrage auszufuehren.
 */
export async function tagsForDocuments(orgId: string, docType: TagDocType, docIds: string[]): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>();
  if (docIds.length === 0) return map;

  const rows = await dbInternal.documentTag.findMany({
    where: { orgId, docType, docId: { in: docIds } },
    select: {
      docId: true,
      tag: { select: { id: true, name: true, color: true, createdAt: true, updatedAt: true, _count: { select: { documents: true } } } },
    },
    orderBy: { tag: { name: "asc" } },
  });

  for (const row of rows) {
    const list = map.get(row.docId) ?? [];
    list.push({
      id: row.tag.id,
      name: row.tag.name,
      color: row.tag.color,
      createdAt: row.tag.createdAt,
      updatedAt: row.tag.updatedAt,
      documentCount: row.tag._count.documents,
    });
    map.set(row.docId, list);
  }
  return map;
}

/** Beleg-IDs, die einen bestimmten Tag tragen (FilterBar-Filter `tag`) — auf TAG_FILTER_LIMIT gedeckelt. */
export async function docIdsForTag(orgId: string, tagId: string, docType: TagDocType): Promise<string[]> {
  const rows = await dbInternal.documentTag.findMany({
    where: { orgId, tagId, docType },
    select: { docId: true },
    take: TAG_FILTER_LIMIT,
  });
  return rows.map((r) => r.docId);
}
