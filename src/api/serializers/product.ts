import { iso } from "./common";
import type { Product } from "@/generated/prisma/client";

export function serializeProduct(p: Product) {
  return {
    objectName: "Product" as const,
    id: p.id,
    name: p.name,
    description: p.description,
    articleNumber: p.articleNumber,
    unit: p.unit,
    netPriceCents: p.netPriceCents,
    taxRate: p.taxRate,
    taxCategory: p.taxCategory,
    differential: p.differential,
    isArchived: p.isArchived,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}
