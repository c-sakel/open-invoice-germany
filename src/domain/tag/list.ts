/**
 * Lesende Tag-Abfragen (Phase 13d, Task 2): Tags je Beleg (Detailkarte/Listen, eine
 * Abfrage statt N+1) und Beleg-IDs je Tag (FilterBar-Filter `tag`, 13a-Nachtrag). Phase
 * 13d, Task 5 ergaenzt die paginierte `listTagsApi`/`getTagRow` fuer `/api/v1/Tag`.
 */
import { cache } from "react";
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import type { TagDocType } from "@/schemas/tag";
import type { TagRow } from "@/domain/tag/manage";

/** Deckelt docIdsForTag gegen unbegrenztes Laden bei sehr vielen Zuordnungen. */
export const TAG_FILTER_LIMIT = 10_000;

/** Dieselbe Projektion wie `listTags` (src/domain/tag/manage.ts) — dort UI-seitig ohne
 *  Paginierung, hier fuer `/api/v1/Tag` (Liste UND Einzelzugriff) wiederverwendet. */
const TAG_ROW_SELECT = {
  id: true,
  name: true,
  color: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { documents: true } },
} as const;

function toTagRow(r: { id: string; name: string; color: string; createdAt: Date; updatedAt: Date; _count: { documents: number } }): TagRow {
  return { id: r.id, name: r.name, color: r.color, createdAt: r.createdAt, updatedAt: r.updatedAt, documentCount: r._count.documents };
}

export const tagListApiFilterSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TagListApiFilter = z.infer<typeof tagListApiFilterSchema>;

export interface TagListApiResult {
  rows: TagRow[];
  total: number;
  limit: number;
  offset: number;
}

/** Paginierte Listenfunktion fuer `GET /api/v1/Tag` (Phase 13d, Task 5, Muster
 *  src/domain/text-template/list.ts#listTextTemplatesApi). */
export async function listTagsApi(orgId: string, rawFilter: unknown): Promise<TagListApiResult> {
  const filter = tagListApiFilterSchema.parse(rawFilter);
  const [total, rows] = await Promise.all([
    dbInternal.tag.count({ where: { orgId } }),
    dbInternal.tag.findMany({ where: { orgId }, orderBy: { name: "asc" }, skip: filter.offset, take: filter.limit, select: TAG_ROW_SELECT }),
  ]);
  return { rows: rows.map(toTagRow), total, limit: filter.limit, offset: filter.offset };
}

/** Ein einzelner Tag MIT Zuordnungszahl (fuer `GET`/`PATCH`/`DELETE`
 *  `/api/v1/Tag/{id}` — dieselbe Form wie `listTagsApi`, damit `serializeTag` fuer Liste
 *  UND Einzelzugriff dasselbe Schema bedient). `null`, wenn kein Tag der Organisation
 *  mit dieser id existiert. */
export async function getTagRow(orgId: string, id: string): Promise<TagRow | null> {
  const r = await dbInternal.tag.findFirst({ where: { id, orgId }, select: TAG_ROW_SELECT });
  return r ? toTagRow(r) : null;
}

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

/**
 * Beleg-IDs, die einen bestimmten Tag tragen (FilterBar-Filter `tag`) — auf
 * TAG_FILTER_LIMIT gedeckelt, neueste Zuordnung zuerst (nit 8: `take` ohne `orderBy`
 * lieferte bei erreichtem Deckel eine nicht deterministische Teilmenge). Ueber React
 * `cache()` je Anfrage memoisiert (Muster `billingStateIndex`, Fix-Welle 1, must 1) —
 * `invoiceFilterConditions`/`quoteFilterConditions`/`deliveryNoteFilterConditions` UND die
 * jeweilige `list*`-Funktion rufen dieselbe (orgId, tagId, docType)-Kombination auf und
 * sehen dadurch garantiert dieselbe Id-Liste, ohne die Abfrage doppelt auszufuehren.
 */
export const docIdsForTag = cache(async (orgId: string, tagId: string, docType: TagDocType): Promise<string[]> => {
  const rows = await dbInternal.documentTag.findMany({
    where: { orgId, tagId, docType },
    select: { docId: true },
    orderBy: { createdAt: "desc" },
    take: TAG_FILTER_LIMIT,
  });
  return rows.map((r) => r.docId);
});
