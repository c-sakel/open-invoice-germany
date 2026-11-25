/**
 * Legt ein Abo im Zustand eines Bestandsabos an (nachträglich, ohne Ankertag, Stichtag = Startdatum),
 * wie es vor der Abrechnungsart existierte. Die Anlage über `createRecurring` leitet Stichtag und
 * Anker neu ab; Tests des unveränderten Bestandsverhaltens setzen die Zeile danach zurück.
 */
import { dbInternal } from "@/lib/db";
import { createRecurring } from "@/domain/recurring/create";
import { normalizeToNoon } from "@/lib/recurring";
import type { CreateRecurringInput } from "@/schemas";

export async function createBestandRecurring(orgId: string, input: CreateRecurringInput) {
  const wanted = normalizeToNoon(input.startDate);
  const safeStart = new Date(wanted.getFullYear(), wanted.getMonth(), 1, 12, 0, 0, 0);
  const created = await createRecurring(orgId, { ...input, startDate: safeStart, anchorDay: undefined, billingTiming: "ARREARS" });
  await dbInternal.recurringInvoice.update({
    where: { id: created.id },
    data: { startDate: wanted, nextRunDate: wanted, anchorDay: null, billingTiming: "ARREARS" },
  });
  return dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: created.id }, include: { lines: { orderBy: { position: "asc" } } } });
}
