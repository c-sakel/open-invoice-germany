import { iso } from "./common";
import type { PaymentMethod } from "@/generated/prisma/client";

export function serializePaymentMethod(m: PaymentMethod) {
  return {
    objectName: "PaymentMethod" as const,
    id: m.id,
    code: m.code,
    name: m.name,
    description: m.description,
    paymentTermsDays: m.paymentTermsDays,
    invoiceText: m.invoiceText,
    bankAccountRef: m.bankAccountRef,
    bankIban: m.bankIban,
    bankBic: m.bankBic,
    bankName: m.bankName,
    untdidCode: m.untdidCode,
    isSystem: m.isSystem,
    isActive: m.isActive,
    sortOrder: m.sortOrder,
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
  };
}
