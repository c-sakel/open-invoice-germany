/**
 * Bearbeiten eines Lieferschein-Entwurfs (Phase 17b). Nur Status DRAFT; Positionen werden
 * ersetzt, Kunde/Ansprechpartner/Lieferadresse neu aufgeloest (Default-Adresse des neuen
 * Kunden bei Kundenwechsel). Quelle (sourceType/sourceId) bleibt unveraendert; Positionen
 * behalten ihren `sourceLineId`-Bezug. Entwuerfe tragen weder Nummer noch Snapshot und
 * reservieren keine Menge — die harte Restmengenpruefung folgt bei DRAFT -> CREATED.
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { DeliveryNoteValidationError } from "@/domain/delivery-note/errors";
import { NotFoundError } from "@/domain/errors";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { assertAllowedTaxRates, ratesOfLines } from "@/domain/settings/tax-rates";
import { resolveDeliveryParties } from "@/domain/delivery-note/parties";
import { DeliveryNoteError, DeliveryNoteNotDraftError } from "@/domain/delivery-note/errors";
import { updateDeliveryNoteSchema } from "@/schemas";

export { DeliveryNoteNotDraftError };

export type DeliveryNoteWithLines = Prisma.DeliveryNoteGetPayload<{ include: { lines: true } }>;

export async function updateDraftDeliveryNote(
  orgId: string,
  id: string,
  rawInput: unknown,
  opts: { actor?: string; now?: Date } = {},
): Promise<DeliveryNoteWithLines> {
  const input = updateDeliveryNoteSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "system";

  return dbInternal.$transaction(async (tx) => {
    // Zeilensperre (17b) als erste Anweisung: Statuspruefung erst danach, sonst Race gegen DRAFT -> CREATED.
    await lockRow(tx, "DeliveryNote", id, orgId);
    const note = await tx.deliveryNote.findFirst({
      where: { id, orgId },
      select: { id: true, status: true, sourceType: true, sourceId: true, customerId: true, contactPersonId: true, shippingAddressId: true, _count: { select: { lines: true } } },
    });
    if (!note) throw new NotFoundError(`Lieferschein ${id} nicht gefunden.`);
    if (note.status !== "DRAFT") throw new DeliveryNoteNotDraftError();

    const data: Prisma.DeliveryNoteUncheckedUpdateInput = {};
    const changed: string[] = [];

    // Parteien: bei Kundenwechsel greifen die Defaults des neuen Kunden, sonst bleibt die
    // bisherige Auswahl, solange nichts Neues angegeben wird.
    const customerId = input.customerId ?? note.customerId;
    const customerChanged = customerId !== note.customerId;
    const touchesParties = customerChanged || input.contactPersonId !== undefined || input.shippingAddressId !== undefined;
    if (touchesParties) {
      const parties = await resolveDeliveryParties(tx, orgId, customerId, {
        contactPersonId: input.contactPersonId !== undefined ? input.contactPersonId : customerChanged ? undefined : note.contactPersonId,
        shippingAddressId: input.shippingAddressId !== undefined ? input.shippingAddressId : customerChanged ? undefined : note.shippingAddressId,
      });
      data.customerId = customerId;
      data.contactPersonId = parties.contactPersonId;
      data.shippingAddressId = parties.shippingAddressId;
      changed.push("customerId", "contactPersonId", "shippingAddressId");
    }

    const simple = ["deliveryDate", "shippingDate", "showPrices", "showTax", "showArticleNumber", "showDescription", "showDeliveryAddress", "language", "headerText", "footerText", "notes", "internalNotes"] as const;
    for (const key of simple) {
      const v = input[key];
      if (v !== undefined) {
        (data as Record<string, unknown>)[key] = v;
        changed.push(key);
      }
    }

    if (input.lines) {
      // Die Quelle des Kopfes bleibt unveraendert: Zeilenbezuege muessen auf genau diese Quelle zeigen.
      for (const [i, l] of input.lines.entries()) {
        if (!l.sourceType && !l.sourceId && !l.sourceLineId) continue;
        if (l.sourceType !== note.sourceType || l.sourceId !== note.sourceId) {
          throw new DeliveryNoteValidationError(`Position ${i + 1}: Quellbezug passt nicht zur Quelle des Lieferscheins.`);
        }
      }
      // Bereits im Entwurf enthaltene Saetze (z. B. von der Quelle geerbt) bleiben erlaubt.
      const current = await tx.deliveryNoteLine.findMany({ where: { deliveryNoteId: id }, select: { taxRate: true } });
      await assertAllowedTaxRates(tx, orgId, ratesOfLines(input.lines), {
        existing: current.map((l) => l.taxRate).filter((r): r is number => r !== null),
      });
      await tx.deliveryNoteLine.deleteMany({ where: { deliveryNoteId: id } });
      await tx.deliveryNoteLine.createMany({
        data: input.lines.map((l, i) => ({
          deliveryNoteId: id,
          position: i + 1,
          description: l.description,
          articleNumber: l.articleNumber,
          quantityMilli: l.quantityMilli,
          unit: l.unit,
          sourceType: l.sourceType,
          sourceId: l.sourceId,
          sourceLineId: l.sourceLineId,
          unitNetPriceCents: l.unitNetPriceCents,
          taxRate: l.taxRate,
        })),
      });
      changed.push("lines");
    }
    if (changed.length === 0) throw new DeliveryNoteError("Keine Aenderung angegeben.");

    const updated = await tx.deliveryNote.update({ where: { id }, data, include: { lines: { orderBy: { position: "asc" } } } });

    await appendChangeLog(tx, {
      orgId,
      entity: "DELIVERY_NOTE",
      entityId: id,
      action: "UPDATE",
      actor,
      at: now,
      diff: { fields: [...new Set(changed)], ...(input.lines ? { lines: { from: note._count.lines, to: updated.lines.length } } : {}) },
    });
    await logActivity(tx, { orgId, entityType: "DELIVERY_NOTE", entityId: id, type: "UPDATED", actor, at: now, data: { draft: true } });
    return updated;
  });
}
