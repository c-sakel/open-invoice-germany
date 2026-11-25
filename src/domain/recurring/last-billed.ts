/**
 * Letzter abgerechneter Leistungszeitraum eines Abos (inklusive Grenzen).
 *
 * Einzelrechnungen tragen die Herkunft am Beleg (`recurringInvoiceId`), Sammelrechnungen nur an den
 * Positionen (`InvoiceLine.recurringInvoiceId`) und als Relation GENERATED_BY. Entwürfe und stornierte
 * Rechnungen zählen nicht (sie haben nichts abgerechnet). Immer auf die Organisation begrenzt.
 */
import type { Prisma } from "@/generated/prisma/client";

export interface BilledPeriod {
  start: Date;
  end: Date;
}

export interface LastBilledSource {
  deliveryStart: Date | null;
  deliveryEnd: Date | null;
  deliveryDate: Date | null;
  lines: { servicePeriodStart: Date | null; servicePeriodEnd: Date | null }[];
}

/** Zeitraum der Rechnung für dieses Abo: bei Sammelrechnung der BG-26 der Zeilen dieses Abos, sonst der Kopf. */
export function billedPeriodOf(inv: LastBilledSource): BilledPeriod | null {
  const dated = inv.lines.filter((l) => l.servicePeriodStart && l.servicePeriodEnd);
  if (dated.length > 0) {
    let start = dated[0].servicePeriodStart as Date;
    let end = dated[0].servicePeriodEnd as Date;
    for (const l of dated) {
      if ((l.servicePeriodStart as Date).getTime() < start.getTime()) start = l.servicePeriodStart as Date;
      if ((l.servicePeriodEnd as Date).getTime() > end.getTime()) end = l.servicePeriodEnd as Date;
    }
    return { start, end };
  }
  if (inv.deliveryStart && inv.deliveryEnd) return { start: inv.deliveryStart, end: inv.deliveryEnd };
  return null;
}

/**
 * Neueste festgeschriebene Rechnung des Abos (Einzel- oder Sammelrechnung). `deliveryDate` ist der
 * Bestandsfall ohne Leistungszeitraum (Leistungsdatum = Stichtag).
 */
export async function findLastBilled(
  tx: Prisma.TransactionClient,
  orgId: string,
  recurringId: string,
): Promise<{ period: BilledPeriod | null; deliveryDate: Date | null } | null> {
  const rels = await tx.documentRelation.findMany({
    where: { orgId, relationType: "GENERATED_BY", fromType: "INVOICE", toType: "RECURRING", toId: recurringId },
    select: { fromId: true },
  });
  const viaRelation = rels.map((r) => r.fromId);
  const last = await tx.invoice.findFirst({
    where: {
      orgId,
      type: "INVOICE",
      status: { notIn: ["DRAFT", "CANCELLED"] },
      OR: [{ recurringInvoiceId: recurringId }, ...(viaRelation.length > 0 ? [{ id: { in: viaRelation } }] : [])],
    },
    orderBy: [{ createdAt: "desc" }],
    select: {
      deliveryStart: true,
      deliveryEnd: true,
      deliveryDate: true,
      lines: { where: { recurringInvoiceId: recurringId }, select: { servicePeriodStart: true, servicePeriodEnd: true } },
    },
  });
  if (!last) return null;
  return { period: billedPeriodOf(last), deliveryDate: last.deliveryDate };
}
