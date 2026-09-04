import { iso } from "./common";
import type { Payment } from "@/generated/prisma/client";

export function serializePayment(p: Payment) {
  return {
    objectName: "Payment" as const,
    id: p.id,
    invoiceId: p.invoiceId,
    amountCents: p.amountCents,
    paidAt: iso(p.paidAt),
    method: p.method,
    reference: p.reference,
    isSkonto: p.isSkonto,
    skontoForPaymentId: p.skontoForPaymentId,
    note: p.note,
    createdAt: iso(p.createdAt),
  };
}
