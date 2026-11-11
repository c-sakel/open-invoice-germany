/**
 * OSS-Kategorie-Snapshot fuer Beleg-Positionen (Phase 16e): explizite Angabe > Kategorie des
 * Produkts (nur der eigenen Organisation) > null. Eine einzige Abfrage fuer alle Produkte.
 */
import type { Prisma } from "@/generated/prisma/client";
import { OssCategorySchema, type OssCategory } from "@/schemas/oss";

export async function resolveLineOssCategories(
  tx: Prisma.TransactionClient,
  orgId: string,
  lines: ReadonlyArray<{ productId?: string | null; ossCategory?: OssCategory }>,
): Promise<(OssCategory | null)[]> {
  const ids = Array.from(new Set(lines.filter((l) => l.ossCategory === undefined && l.productId).map((l) => l.productId as string)));
  const byId = new Map<string, OssCategory>();
  if (ids.length > 0) {
    const products = await tx.product.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, ossCategory: true } });
    for (const p of products) {
      const parsed = OssCategorySchema.safeParse(p.ossCategory);
      byId.set(p.id, parsed.success ? parsed.data : "NONE");
    }
  }
  return lines.map((l) => l.ossCategory ?? (l.productId ? (byId.get(l.productId) ?? null) : null));
}

/** Gespeicherten Kategorie-Text (Quell-Position) fuer die Weitergabe an createDraftInvoice pruefen; unbekannt/leer -> undefined. */
export function parseOss(value: string | null | undefined): OssCategory | undefined {
  const parsed = OssCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
