import { iso } from "./common";
import type { Dunning } from "@/generated/prisma/client";

export function serializeDunning(d: Dunning) {
  return {
    objectName: "Dunning" as const,
    id: d.id,
    invoiceId: d.invoiceId,
    stageId: d.stageId,
    number: d.number,
    level: d.level,
    sentAt: iso(d.sentAt),
    dueDate: iso(d.dueDate),
    baseInterestRatePermille: d.baseInterestRatePermille,
    interestRatePoints: d.interestRatePoints,
    interestAmountCents: d.interestAmountCents,
    lateFeeCents: d.lateFeeCents,
    flatFee40Cents: d.flatFee40Cents,
    claimBaseCents: d.claimBaseCents,
    feeCents: d.feeCents,
    invoiceNumber: d.invoiceNumber,
    invoiceDueDate: iso(d.invoiceDueDate),
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt),
  };
}
