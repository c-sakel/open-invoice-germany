import { iso } from "./common";
import { serializeDeliveryNoteLine } from "./lines";
import type { DeliveryNote, DeliveryNoteLine, Customer } from "@/generated/prisma/client";

export type DeliveryNoteWithOptionalRelations = DeliveryNote & { lines?: DeliveryNoteLine[]; customer?: Customer };

export function serializeDeliveryNote(dn: DeliveryNoteWithOptionalRelations, embed: Set<string>) {
  return {
    objectName: "DeliveryNote" as const,
    id: dn.id,
    number: dn.number,
    status: dn.status,
    customerId: dn.customerId,
    contactPersonId: dn.contactPersonId,
    shippingAddressId: dn.shippingAddressId,
    issueDate: iso(dn.issueDate),
    deliveryDate: iso(dn.deliveryDate),
    shippingDate: iso(dn.shippingDate),
    showPrices: dn.showPrices,
    showTax: dn.showTax,
    showArticleNumber: dn.showArticleNumber,
    showDescription: dn.showDescription,
    showDeliveryAddress: dn.showDeliveryAddress,
    notes: dn.notes,
    headerText: dn.headerText,
    footerText: dn.footerText,
    sourceType: dn.sourceType,
    sourceId: dn.sourceId,
    sentAt: iso(dn.sentAt),
    deliveredAt: iso(dn.deliveredAt),
    archivedAt: iso(dn.archivedAt),
    createdAt: iso(dn.createdAt),
    updatedAt: iso(dn.updatedAt),
    ...(embed.has("customer") && dn.customer ? { customerName: dn.customer.name } : {}),
    ...(embed.has("lines") ? { lines: (dn.lines ?? []).map(serializeDeliveryNoteLine) } : {}),
  };
}
