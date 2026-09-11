/**
 * Serialisierer fuer `/api/v1/Tag` (Phase 13d, Task 5, Muster
 * src/api/serializers/text-template.ts). Nimmt `TagRow` (src/domain/tag/manage.ts) statt
 * der rohen Prisma-Zeile entgegen — `documentCount` ist keine Spalte, sondern der bereits
 * von `listTagsApi`/`getTagRow` (src/domain/tag/list.ts) mitgelieferte `_count`.
 */
import "../openapi-zod-init"; // Fix-Runde 1: MUSS vor jedem z.object()-Aufruf hier stehen
import { iso } from "./common";
import type { TagRow } from "@/domain/tag/manage";
import { z } from "zod";

export function serializeTag(t: TagRow) {
  return {
    objectName: "Tag" as const,
    id: t.id,
    name: t.name,
    color: t.color,
    documentCount: t.documentCount,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

/** OpenAPI-Response-Schema (Phase 13d, Task 5) — aus serializeTag abgeleitet. */
export const tagSchema = z.object({
  objectName: z.literal("Tag"),
  id: z.string(),
  name: z.string(),
  color: z.string(),
  documentCount: z.number().int(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
