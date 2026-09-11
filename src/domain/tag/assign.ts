/**
 * Tag-Zuordnung zu Belegen (Phase 13d, Task 2). Tags sind reine Metadaten (kein
 * GoBD-Belegbestandteil, src/schemas/tag.ts) — setzen/entfernen ist deshalb auch an
 * festgeschriebenen Rechnungen erlaubt: es findet KEIN Schreibvorgang auf
 * invoice/invoiceLine statt, der Guard in src/lib/db.ts bleibt unberuehrt, und es wird
 * NIE die ChangeLog-Hash-Kette geschrieben, sondern das unverkettete ActivityLog
 * (Audit K5, src/domain/activity/log.ts).
 *
 * `tagDocument` ist idempotent (Muster src/domain/notifications/create.ts): eine
 * bereits bestehende Zuordnung erzeugt weder einen Fehler noch einen zweiten
 * ActivityLog-Eintrag.
 */
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import { assertDocExists } from "@/domain/relations";
import { NotFoundError } from "@/domain/errors";
import { tagAssignSchema } from "@/schemas/tag";

/** Ordnet einen Tag einem Beleg zu. `created: false`, wenn die Zuordnung schon bestand. */
export async function tagDocument(orgId: string, tagId: string, rawInput: unknown, actor = "system"): Promise<{ created: boolean }> {
  const input = tagAssignSchema.parse(rawInput);

  const tag = await dbInternal.tag.findFirst({ where: { id: tagId, orgId }, select: { id: true, name: true } });
  if (!tag) throw new NotFoundError(`Tag ${tagId} nicht gefunden.`);
  await assertDocExists(dbInternal, orgId, input.docType, input.docId);

  const now = new Date();
  try {
    await dbInternal.$transaction(async (tx) => {
      await tx.documentTag.create({ data: { orgId, tagId, docType: input.docType, docId: input.docId } });
      await logActivity(tx, {
        orgId,
        entityType: input.docType,
        entityId: input.docId,
        type: "TAG_ADDED",
        actor,
        at: now,
        data: { tagId, name: tag.name },
      });
    });
    return { created: true };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Zuordnung existiert bereits (regulaerer Dedup-Fall oder Race zweier
      // gleichzeitiger Aufrufe) — idempotent, kein Fehler, kein zweiter ActivityLog-
      // Eintrag.
      return { created: false };
    }
    throw e;
  }
}

/** Entfernt die Zuordnung eines Tags von einem Beleg. `removed: false`, wenn keine bestand. */
export async function untagDocument(orgId: string, tagId: string, rawInput: unknown, actor = "system"): Promise<{ removed: boolean }> {
  const input = tagAssignSchema.parse(rawInput);

  const tag = await dbInternal.tag.findFirst({ where: { id: tagId, orgId }, select: { id: true, name: true } });
  if (!tag) throw new NotFoundError(`Tag ${tagId} nicht gefunden.`);

  const now = new Date();
  let removed = false;
  await dbInternal.$transaction(async (tx) => {
    // deleteMany statt delete-by-id: entfernt idempotent (0 oder 1 Zeile), ohne bei
    // einer bereits entfernten Zuordnung einen P2025-Fehler zu werfen (Race-sicher).
    const result = await tx.documentTag.deleteMany({ where: { orgId, tagId, docType: input.docType, docId: input.docId } });
    if (result.count === 0) return;
    removed = true;
    await logActivity(tx, {
      orgId,
      entityType: input.docType,
      entityId: input.docId,
      type: "TAG_REMOVED",
      actor,
      at: now,
      data: { tagId, name: tag.name },
    });
  });
  return { removed };
}
