import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { ensureArticleNumbers } from "@/domain/numbering/ranges";
import { formatCents } from "@/lib/money";
import { unitLabel } from "@/lib/units";
import { archiveProduct } from "@/app/actions/masterdata";

export const dynamic = "force-dynamic";

export default async function ProduktePage() {
  try {
    const org = await getActiveOrg();
    // Selbstheilung (Nit, Final-Review, analog Kundenliste): Bestandsprodukte ohne
    // Artikelnummer bekommen beim ersten Laden der Liste eine — idempotent.
    await ensureArticleNumbers(org.id);
  } catch {
    // Keine Organisation eingerichtet -> keine Produkte vorhanden, Liste bleibt leer.
  }

  const products = await prisma.product.findMany({
    where: { isArchived: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, unit: true, netPriceCents: true, taxRate: true, differential: true },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Produkte & Leistungen"
        subtitle={`${products.length} Produkte`}
        actions={
          <Link href="/produkte/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-white hover:bg-pen">
            Neues Produkt
          </Link>
        }
      />

      {products.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-dashed border-rule-strong bg-sheet p-10 text-center text-ink-muted">
          Noch keine Produkte. Ein Katalog ist optional — du kannst Positionen auch direkt in der Rechnung eintippen.
        </div>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-rule bg-sheet">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3">Bezeichnung</th>
                <th className="px-4 py-3">Einheit</th>
                <th className="px-4 py-3 text-right">Netto</th>
                <th className="px-4 py-3 text-right">USt</th>
                <th className="px-4 py-3 text-right">Aktion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {products.map((p) => (
                <tr key={p.id} className="hover:bg-paper">
                  <td className="px-4 py-3">
                    <Link href={`/produkte/${p.id}`} className="font-medium text-pen hover:underline">
                      {p.name}
                    </Link>
                    {p.differential && <span className="ml-2 rounded bg-well px-1.5 py-0.5 text-xs text-ink-soft">§ 25a</span>}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{unitLabel(p.unit)}</td>
                  <td className="tabular px-4 py-3 text-right">{formatCents(p.netPriceCents)}</td>
                  <td className="tabular px-4 py-3 text-right">{p.taxRate}%</td>
                  <td className="px-4 py-3 text-right">
                    <form action={archiveProduct} className="inline">
                      <input type="hidden" name="id" value={p.id} />
                      <button className="text-xs text-ink-muted hover:text-stamp">Archivieren</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
