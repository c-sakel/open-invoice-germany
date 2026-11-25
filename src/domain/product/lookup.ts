import { prisma, ciContains } from "@/lib/db";
import { lookupQuerySchema } from "@/schemas/lookup";

/** Produktsuche fuer den Belegeditor (nur aktive Produkte der Organisation). */
export async function lookupProducts(orgId: string, raw: unknown) {
  const { q, limit, ids } = lookupQuerySchema.parse(raw);
  const byIds = ids && ids.length > 0;
  return prisma.product.findMany({
    where: {
      orgId,
      // Der ids-Zweig loest auch Archivierte auf (Label gewaehlter Eintraege); die Suche q nie.
      ...(byIds ? { id: { in: ids } } : { isArchived: false }),
      ...(q ? { OR: [{ name: ciContains(q) }, { articleNumber: ciContains(q) }] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, articleNumber: true, isArchived: true },
  });
}
