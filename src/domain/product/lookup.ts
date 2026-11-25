import { prisma, ciContains } from "@/lib/db";
import { lookupQuerySchema } from "@/schemas/lookup";

/** Produktsuche fuer den Belegeditor (nur aktive Produkte der Organisation). */
export async function lookupProducts(orgId: string, raw: unknown) {
  const { q, limit, ids } = lookupQuerySchema.parse(raw);
  return prisma.product.findMany({
    where: {
      orgId,
      isArchived: false,
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
      ...(q ? { OR: [{ name: ciContains(q) }, { articleNumber: ciContains(q) }] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true },
  });
}
