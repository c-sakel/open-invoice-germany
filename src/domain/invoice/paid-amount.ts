/**
 * Atomares Fortschreiben von `Invoice.paidAmountCents` (Lost-Update-Schutz).
 * Bedingtes updateMany: die Obergrenze (`baseCents`, unveraenderlich nach dem
 * Festschreiben) steht in der WHERE-Klausel, der Zuwachs ist ein `increment`. Parallele
 * Vorgaenge (Zahlung/Gutschrift) serialisieren auf der Zeile (Postgres: Zeilensperre und
 * Neubewertung der WHERE-Klausel; SQLite: Schreibsperre) und koennen die Grenze nicht umgehen.
 * Gibt den neuen Stand zurueck oder `null`, wenn die Grenze ueberschritten wuerde.
 */
import type { Prisma } from "@/generated/prisma/client";

export async function incrementPaidAmount(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  baseCents: number,
  deltaCents: number,
): Promise<number | null> {
  const res = await tx.invoice.updateMany({
    where: { id: invoiceId, paidAmountCents: { lte: baseCents - deltaCents } },
    data: { paidAmountCents: { increment: deltaCents } },
  });
  if (res.count === 0) return null;
  const row = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { paidAmountCents: true } });
  return row.paidAmountCents;
}

/**
 * Gegenstueck zu `incrementPaidAmount` fuer Gegenbuchungen (Phase 16a): verringert
 * `paidAmountCents` atomar, die Untergrenze 0 steht in der WHERE-Klausel.
 * Gibt den neuen Stand zurueck oder `null` bei Unterlauf.
 */
export async function decrementPaidAmount(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  deltaCents: number,
): Promise<number | null> {
  const res = await tx.invoice.updateMany({
    where: { id: invoiceId, paidAmountCents: { gte: deltaCents } },
    data: { paidAmountCents: { decrement: deltaCents } },
  });
  if (res.count === 0) return null;
  const row = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { paidAmountCents: true } });
  return row.paidAmountCents;
}
