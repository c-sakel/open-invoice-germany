/**
 * Beschriftung des Abrufprotokolls fuer die Oberflaeche: Belegnummer je Protokollzeile.
 */
import { dbInternal } from "@/lib/db";
import type { PortalEventRow } from "@/domain/portal/access";

export interface PortalEventLabel {
  id: string;
  at: Date;
  kind: string;
  fileKind: string | null;
  docNumber: string | null;
}

export async function labelPortalEvents(orgId: string, rows: PortalEventRow[]): Promise<PortalEventLabel[]> {
  const invoiceIds = [...new Set(rows.filter((r) => r.docType === "INVOICE" && r.docId).map((r) => r.docId!))];
  const dunningIds = [...new Set(rows.filter((r) => r.docType === "DUNNING" && r.docId).map((r) => r.docId!))];
  const [invoices, dunnings] = await Promise.all([
    invoiceIds.length
      ? dbInternal.invoice.findMany({ where: { orgId, id: { in: invoiceIds } }, select: { id: true, number: true } })
      : Promise.resolve([]),
    dunningIds.length
      ? dbInternal.dunning.findMany({ where: { id: { in: dunningIds }, invoice: { orgId } }, select: { id: true, number: true, level: true } })
      : Promise.resolve([]),
  ]);
  const inv = new Map(invoices.map((i) => [i.id, i.number]));
  const dun = new Map(dunnings.map((d) => [d.id, d.number ?? `Mahnung ${d.level}`]));
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    kind: r.kind,
    fileKind: r.fileKind,
    docNumber: r.docId ? ((r.docType === "DUNNING" ? dun.get(r.docId) : inv.get(r.docId)) ?? null) : null,
  }));
}
