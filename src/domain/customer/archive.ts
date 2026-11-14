/**
 * Kunde archivieren. Domain-Funktion, damit Server Action UND MCP-Tool (archive_customer)
 * dieselbe Logik nutzen (Lastenheft §55, keine Bypass-Pfade). Ein aktiver Portal-Link des Kunden
 * wird in derselben Transaktion widerrufen.
 */
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { lockRow } from "@/lib/db-lock";
import { revokePortalLinkInTx } from "@/domain/portal/link";

export async function archiveCustomer(orgId: string, id: string, actor: string = "system"): Promise<void> {
  await dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "Customer", id, orgId);
    const res = await tx.customer.updateMany({ where: { id, orgId }, data: { isArchived: true } });
    if (res.count === 0) throw new NotFoundError("Kunde nicht gefunden.");
    await revokePortalLinkInTx(tx, orgId, id, { actor, reason: "CUSTOMER_ARCHIVED" });
  });
}
