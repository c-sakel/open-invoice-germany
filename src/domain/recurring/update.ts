/**
 * Aendert ein bestehendes Abo (Phase 8b, Task 4, §43) — Task 1/2 kannten nur
 * `createRecurring` (Anlage) und `updateRecurringStatusSchema` (reiner Statuswechsel).
 * Teil-Update: nur uebergebene Felder werden geaendert. Die Vorlage selbst ist KEIN
 * GoBD-Beleg (kein Hash-Chain-Eintrag noetig) — nur die daraus erzeugten Rechnungen sind
 * festgeschrieben und bleiben von dieser Aenderung unberuehrt.
 */
import { dbInternal } from "@/lib/db";
import { normalizeToNoon } from "@/lib/recurring";
import { updateRecurringSchema, type UpdateRecurringInput } from "@/schemas";
import { NotFoundError } from "@/domain/errors";
import { RecurringError } from "@/domain/recurring/create";

export async function updateRecurringInvoice(orgId: string, id: string, raw: unknown) {
  const input: UpdateRecurringInput = updateRecurringSchema.parse(raw);

  const existing = await dbInternal.recurringInvoice.findFirst({ where: { id, orgId }, select: { id: true, startDate: true, endDate: true } });
  if (!existing) throw new NotFoundError("Abo nicht gefunden.");

  const endDate = input.endDate === undefined ? undefined : input.endDate ? normalizeToNoon(input.endDate) : null;
  const effectiveEndDate = endDate === undefined ? existing.endDate : endDate;
  if (effectiveEndDate && effectiveEndDate < existing.startDate) {
    throw new RecurringError("Enddatum liegt vor dem Startdatum.");
  }

  return dbInternal.$transaction(async (tx) => {
    if (input.lines) {
      await tx.recurringInvoiceLine.deleteMany({ where: { recurringInvoiceId: id } });
    }

    return tx.recurringInvoice.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.interval !== undefined ? { interval: input.interval } : {}),
        ...(input.intervalCount !== undefined ? { intervalCount: input.intervalCount } : {}),
        ...(input.anchorDay !== undefined ? { anchorDay: input.anchorDay } : {}),
        ...(endDate !== undefined ? { endDate } : {}),
        ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
        ...(input.paymentTermsDays !== undefined ? { paymentTermsDays: input.paymentTermsDays } : {}),
        ...(input.autoFinalize !== undefined ? { autoFinalize: input.autoFinalize } : {}),
        ...(input.autoSend !== undefined ? { autoSend: input.autoSend } : {}),
        ...(input.emailTemplateId !== undefined ? { emailTemplateId: input.emailTemplateId } : {}),
        ...(input.showPeriodText !== undefined ? { showPeriodText: input.showPeriodText } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.lines
          ? {
              lines: {
                create: input.lines.map((l, i) => ({
                  position: i + 1,
                  description: l.description,
                  quantityMilli: l.quantityMilli,
                  unit: l.unit,
                  unitNetPriceCents: l.unitNetPriceCents,
                  taxRate: l.taxRate,
                  taxCategory: l.taxCategory,
                  discountPermille: l.discountPermille,
                })),
              },
            }
          : {}),
      },
      include: { lines: { orderBy: { position: "asc" } } },
    });
  });
}
