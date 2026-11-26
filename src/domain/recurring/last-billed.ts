/**
 * Letzter abgerechneter Leistungszeitraum eines Abos (inklusive Grenzen).
 *
 * Einzelrechnungen tragen die Herkunft am Beleg (`recurringInvoiceId`), Sammelrechnungen nur an den
 * Positionen (`InvoiceLine.recurringInvoiceId`) und als Relation GENERATED_BY. Entwürfe und stornierte
 * Rechnungen zählen nicht (sie haben nichts abgerechnet). Immer auf die Organisation begrenzt.
 */
import type { Prisma } from "@/generated/prisma/client";

/** Anzahl zuletzt erstellter Rechnungen, unter denen das spaeteste Ende gesucht wird. */
const LAST_BILLED_WINDOW = 50;

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
 * Festgeschriebene Rechnung des Abos (Einzel- oder Sammelrechnung) mit dem spaetesten abgerechneten Ende.
 * Massgeblich ist das Zeitraumende (bzw. `deliveryDate` im Bestandsfall ohne Leistungszeitraum), nicht die
 * Erstellungszeit: wird eine aeltere Periode nachtraeglich erzeugt, darf sie den Anschluss nicht zuruecksetzen.
 * Betrachtet werden die zuletzt erstellten Rechnungen (Obergrenze, siehe `LAST_BILLED_WINDOW`).
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
  const candidates = await tx.invoice.findMany({
    where: {
      orgId,
      type: "INVOICE",
      status: { notIn: ["DRAFT", "CANCELLED"] },
      OR: [{ recurringInvoiceId: recurringId }, ...(viaRelation.length > 0 ? [{ id: { in: viaRelation } }] : [])],
    },
    orderBy: [{ createdAt: "desc" }],
    take: LAST_BILLED_WINDOW,
    select: {
      deliveryStart: true,
      deliveryEnd: true,
      deliveryDate: true,
      lines: { where: { recurringInvoiceId: recurringId }, select: { servicePeriodStart: true, servicePeriodEnd: true } },
    },
  });
  let best: { period: BilledPeriod | null; deliveryDate: Date | null; endMs: number } | null = null;
  for (const inv of candidates) {
    const period = billedPeriodOf(inv);
    const end = period?.end ?? inv.deliveryDate;
    const endMs = end ? end.getTime() : Number.NEGATIVE_INFINITY;
    if (!best || endMs > best.endMs) best = { period, deliveryDate: inv.deliveryDate, endMs };
  }
  if (!best) return null;
  return { period: best.period, deliveryDate: best.deliveryDate };
}

/**
 * Ende des zuletzt abgerechneten Zeitraums fuer die Vorschau (wie der Lauf: nur nachtraeglich abgerechnete
 * Bestandsabos ohne Ankertag). Sonst null. Eine Abfrage je Abo, deshalb nur fuer Einzelansichten.
 */
export async function findPreviewPreviousEnd(
  tx: Prisma.TransactionClient,
  rec: { id: string; orgId: string; billingTiming: string; anchorDay: number | null; status: string },
): Promise<Date | null> {
  if (rec.status !== "ACTIVE" || rec.billingTiming !== "ARREARS" || rec.anchorDay !== null) return null;
  const last = await findLastBilled(tx, rec.orgId, rec.id);
  return last?.period?.end ?? last?.deliveryDate ?? null;
}
