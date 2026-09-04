import type { QuoteLine, InvoiceLine, DeliveryNoteLine } from "@/generated/prisma/client";

export function serializeQuoteLine(l: QuoteLine) {
  return {
    id: l.id,
    position: l.position,
    lineType: l.lineType,
    description: l.description,
    descriptionLong: l.descriptionLong,
    articleNumber: l.articleNumber,
    quantityMilli: l.quantityMilli,
    unit: l.unit,
    unitNetPriceCents: l.unitNetPriceCents,
    taxRate: l.taxRate,
    taxCategory: l.taxCategory,
    discountPermille: l.discountPermille,
    discountCents: l.discountCents,
    lineNetCents: l.lineNetCents,
  };
}

export function serializeInvoiceLine(l: InvoiceLine) {
  return {
    id: l.id,
    position: l.position,
    lineType: l.lineType,
    productId: l.productId,
    description: l.description,
    descriptionLong: l.descriptionLong,
    articleNumber: l.articleNumber,
    quantityMilli: l.quantityMilli,
    unit: l.unit,
    unitNetPriceCents: l.unitNetPriceCents,
    taxRate: l.taxRate,
    taxCategory: l.taxCategory,
    discountPermille: l.discountPermille,
    discountCents: l.discountCents,
    lineNetCents: l.lineNetCents,
  };
}

export function serializeDeliveryNoteLine(l: DeliveryNoteLine) {
  return {
    id: l.id,
    position: l.position,
    sourceType: l.sourceType,
    sourceId: l.sourceId,
    sourceLineId: l.sourceLineId,
    description: l.description,
    articleNumber: l.articleNumber,
    quantityMilli: l.quantityMilli,
    unit: l.unit,
    unitNetPriceCents: l.unitNetPriceCents,
    taxRate: l.taxRate,
  };
}
