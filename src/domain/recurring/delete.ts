/**
 * Loescht ein Abo (Vorlage, kein Beleg). Abos mit erfassten Verbrauchssaetzen (FK RESTRICT) oder
 * erzeugten Rechnungen bleiben erhalten — statt eines Datenbankfehlers kommt eine klare
 * Fachmeldung; das Abo wird dann beendet (Status ENDED) statt geloescht.
 */
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { NotFoundError } from "@/domain/errors";
import { RecurringError } from "@/domain/recurring/errors";

export async function deleteRecurringInvoice(orgId: string, id: string): Promise<void> {
  await dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "RecurringInvoice", id, orgId);
    const rec = await tx.recurringInvoice.findFirst({ where: { id, orgId }, select: { id: true } });
    if (!rec) throw new NotFoundError("Abo nicht gefunden.");
    const usages = await tx.recurringUsage.count({ where: { recurringInvoiceId: id } });
    if (usages > 0) {
      throw new RecurringError(`Das Abo hat ${usages} erfasste Verbrauchssätze und kann nicht gelöscht werden. Bitte stattdessen beenden.`);
    }
    const invoices = await tx.invoice.count({ where: { recurringInvoiceId: id, orgId } });
    if (invoices > 0) {
      throw new RecurringError(`Aus dem Abo wurden ${invoices} Rechnung(en) erzeugt; es kann nicht gelöscht werden. Bitte stattdessen beenden.`);
    }
    await tx.recurringInvoice.delete({ where: { id } });
  });
}
