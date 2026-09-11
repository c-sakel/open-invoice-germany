/**
 * Zod-Schemas fuer Tags (Phase 13d, Task 2) — Ordnungsmerkmal ueber Belegen
 * (prisma/schema.prisma, Modelle Tag/DocumentTag). Tags sind reine Metadaten, kein
 * GoBD-Belegbestandteil: auch an festgeschriebenen Rechnungen setz-/entfernbar
 * (src/domain/tag/assign.ts).
 */
import { z } from "zod";

/** Acht feste Farbwerte statt freiem Hex-Code — die UI ordnet sie Tailwind-Klassen zu. */
export const TagColor = z.enum(["slate", "rose", "amber", "emerald", "sky", "indigo", "violet", "stone"]);
export type TagColor = z.infer<typeof TagColor>;

/** Belegtypen, die Tags tragen koennen (Lastenheft-Abgrenzung: keine Mahnungen/Wiederkehrende). */
export const TagDocType = z.enum(["INVOICE", "QUOTE", "DELIVERY_NOTE"]);
export type TagDocType = z.infer<typeof TagDocType>;

export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: TagColor.default("slate"),
});
export type TagInput = z.infer<typeof tagInputSchema>;

export const tagAssignSchema = z.object({
  docType: TagDocType,
  docId: z.string().min(1),
});
export type TagAssignInput = z.infer<typeof tagAssignSchema>;
