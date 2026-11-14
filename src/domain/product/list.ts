/** Phase 10, Task 2 (task-2-facts.md): kleine Listenfunktion fuer die Product-Ressource. */
import { z } from "zod";
import { prisma, ciContains } from "@/lib/db";
import { nextSyncCursor, resolveSyncWindow, syncFilterShape, syncWhere, SYNC_ORDER_BY } from "@/domain/sync/updated-since";
import type { Product } from "@/generated/prisma/client";

export const productListFilterSchema = z.object({
  search: z.string().max(100).optional(),
  includeArchived: z.boolean().optional(),
  ...syncFilterShape,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ProductListFilter = z.infer<typeof productListFilterSchema>;

export interface ProductListResult {
  rows: Product[];
  total: number;
  limit: number;
  offset: number;
  /** Nur im Abgleich (updatedSince): Cursor der Folgeseite, null = letzte Seite. */
  nextCursor?: string | null;
}

export async function listProductsApi(orgId: string, rawFilter: unknown): Promise<ProductListResult> {
  const filter = productListFilterSchema.parse(rawFilter);
  const sync = resolveSyncWindow(rawFilter, filter);
  const where = {
    orgId,
    ...(filter.includeArchived ? {} : { isArchived: false }),
    ...(filter.search ? { OR: [{ name: ciContains(filter.search) }, { articleNumber: ciContains(filter.search) }] } : {}),
  };
  const windowWhere = sync ? { AND: [where, syncWhere({ since: sync.since, after: null })] } : where;
  const pageWhere = sync && sync.after ? { AND: [where, syncWhere(sync)] } : windowWhere;
  const [total, rows] = await Promise.all([
    prisma.product.count({ where: windowWhere }),
    prisma.product.findMany(
      sync
        ? { where: pageWhere, orderBy: [...SYNC_ORDER_BY], take: filter.limit }
        : { where, orderBy: { createdAt: "desc" }, skip: filter.offset, take: filter.limit },
    ),
  ]);
  return { rows, total, limit: filter.limit, offset: filter.offset, ...(sync ? { nextCursor: nextSyncCursor(rows, filter.limit) } : {}) };
}
