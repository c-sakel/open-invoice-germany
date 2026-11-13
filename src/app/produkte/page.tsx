import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CsvLink } from "@/components/ui/CsvLink";
import { prisma } from "@/lib/db";
import { getActiveOrg } from "@/lib/org";
import { ensureArticleNumbers } from "@/domain/numbering/ranges";
import { formatCents } from "@/lib/money";
import { unitLabel } from "@/lib/units";
import { archiveProduct } from "@/app/actions/masterdata";
import { DataTable } from "@/components/ui/DataTable";
import { loadDocumentSettings } from "@/domain/document/settings";
import { topProducts } from "@/domain/reporting/top-products";

export const dynamic = "force-dynamic";

export default async function ProduktePage({ searchParams }: { searchParams: Promise<{ archiviert?: string }> }) {
  const { archiviert } = await searchParams;
  try {
    const org = await getActiveOrg();
    // Selbstheilung (Nit, Final-Review, analog Kundenliste): Bestandsprodukte ohne
    // Artikelnummer bekommen beim ersten Laden der Liste eine — idempotent.
    await ensureArticleNumbers(org.id);
  } catch {
    // Keine Organisation eingerichtet -> keine Produkte vorhanden, Liste bleibt leer.
  }

  // G12: Umsatz je Produkt (12 Monate) in Standardwaehrung — Inline-Balken relativ zum Maximum.
  let currency = "EUR";
  const revenueByProduct = new Map<string, number>();
  try {
    const org = await getActiveOrg();
    currency = (await loadDocumentSettings(org.id)).defaultCurrency;
    const top = await topProducts(org.id, { limit: 10 });
    for (const t of top) if (t.currency === currency) revenueByProduct.set(t.productId, t.netCents);
  } catch {
    // Keine Organisation eingerichtet -> keine Umsatzwerte.
  }
  const maxRevenue = Math.max(0, ...revenueByProduct.values());

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
          <>
            <CsvLink href={"/api/exports/produkte.csv" + (archiviert === "1" ? "?archiviert=1" : "")} what="Produkte" />
            <Link href="/produkte/import" className="text-sm text-ink-soft underline-offset-2 hover:underline">
              Importieren
            </Link>
            <Link href="/produkte/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
              Neues Produkt
            </Link>
          </>
        }
      />

      <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
        <DataTable
          caption="Produkte und Leistungen"
          rows={products}
          rowKey={(p) => p.id}
          empty={{
            text: "Noch keine Produkte. Ein Katalog ist optional — du kannst Positionen auch direkt in der Rechnung eintippen.",
            action: { label: "Neu anlegen", href: "/produkte/neu" },
          }}
          columns={[
            {
              key: "name",
              header: "Bezeichnung",
              mobile: "title",
              cell: (p) => (
                <>
                  <Link href={`/produkte/${p.id}`} className="break-words font-medium text-pen hover:underline">
                    {p.name}
                  </Link>
                  {p.differential && <span className="ml-2 rounded bg-well px-1.5 py-0.5 text-xs text-ink-soft">§ 25a</span>}
                </>
              ),
            },
            { key: "unit", header: "Einheit", mobile: "meta", cell: (p) => <span className="text-ink-soft">{unitLabel(p.unit)}</span> },
            { key: "net", header: "Netto", mobile: "amount", cell: (p) => formatCents(p.netPriceCents) },
            { key: "tax", header: "USt", align: "right", mobile: "meta", cell: (p) => `${p.taxRate}%` },
            {
              key: "revenue",
              header: "Umsatz 12 M (Top 10)",
              align: "right",
              mobile: "meta",
              cell: (p) => {
                const cents = revenueByProduct.get(p.id) ?? 0;
                const pct = maxRevenue > 0 ? Math.max(0, Math.min(100, Math.round((cents / maxRevenue) * 100))) : 0;
                return (
                  <span className="inline-flex items-center justify-end gap-2">
                    <span aria-hidden="true" className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-well">
                      <span className="block h-full rounded-full bg-pen" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="tabular whitespace-nowrap text-ink-soft">{cents > 0 ? formatCents(cents, currency) : "—"}</span>
                  </span>
                );
              },
            },
            {
              key: "action",
              header: "Aktion",
              align: "right",
              mobile: "meta",
              cell: (p) => (
                <form action={archiveProduct} className="inline">
                  <input type="hidden" name="id" value={p.id} />
                  <button className="inline-flex min-h-8 items-center text-xs text-ink-muted hover:text-stamp">Archivieren</button>
                </form>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
