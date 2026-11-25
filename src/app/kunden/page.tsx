import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CsvLink } from "@/components/ui/CsvLink";
import { getActiveOrg } from "@/lib/org";
import { ensureCustomerNumbers } from "@/domain/numbering/ranges";
import { ArchiveCustomerButton } from "./ArchiveCustomerButton";
import { Pagination } from "@/components/list/Pagination";
import { CUSTOMER_LIST_PAGE_SIZE, listCustomersPage } from "@/domain/customer/list";
import { customerListPageSchema } from "@/schemas/customer-list";
import { DataTable } from "@/components/ui/DataTable";

export const dynamic = "force-dynamic";

export default async function KundenPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const parsed = customerListPageSchema.safeParse({ q: sp.q, offset: sp.offset, archiviert: sp.archiviert });
  const input = parsed.success ? parsed.data : customerListPageSchema.parse({});
  const query = input.q ?? "";
  const exportParams = new URLSearchParams();
  if (query) exportParams.set("q", query);
  if (input.archiviert === "1") exportParams.set("archiviert", "1");
  const exportQuery = exportParams.size > 0 ? `?${exportParams.toString()}` : "";

  let page: Awaited<ReturnType<typeof listCustomersPage>> = { rows: [], total: 0, limit: CUSTOMER_LIST_PAGE_SIZE, offset: 0, q: query };
  try {
    const org = await getActiveOrg();
    // Selbstheilung (Phase 7, §34): Bestandskunden ohne Kundennummer bekommen beim ersten
    // Laden der Liste eine — idempotent, kein Effekt bei bereits vergebenen Nummern.
    await ensureCustomerNumbers(org.id);
    page = await listCustomersPage(org.id, input);
  } catch {
    // Keine Organisation eingerichtet -> keine Kunden vorhanden, Liste bleibt leer.
  }
  const customers = page.rows;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kunden"
        subtitle={`${page.total} Kunden`}
        actions={
          <>
            <CsvLink href={"/api/exports/kunden.csv" + exportQuery} what="Kunden" />
            <Link href="/kunden/import" className="text-sm text-ink-soft underline-offset-2 hover:underline">
              Importieren
            </Link>
            <Link href="/kunden/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
              Neuer Kunde
            </Link>
          </>
        }
      />

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Suche nach Name, Nr., E-Mail, Ort, USt-IdNr.…"
          className="w-full max-w-sm rounded-md border border-rule-strong px-3 py-2 text-sm focus:border-pen sm:w-80"
        />
        <button type="submit" className="rounded-md border border-rule-strong px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper">
          Suchen
        </button>
      </form>

      <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
        <DataTable
          caption="Kunden"
          rows={customers}
          rowKey={(c) => c.id}
          empty={{ text: "Noch keine Kunden. Lege deinen ersten Kunden an.", action: { label: "Neu anlegen", href: "/kunden/neu" } }}
          columns={[
            { key: "nr", header: "Nr.", mobile: "meta", cell: (c) => <span className="text-ink-muted">{c.customerNumber ?? "—"}</span> },
            {
              key: "name",
              header: "Name",
              mobile: "title",
              cell: (c) => (
                <Link prefetch={false} href={`/kunden/${c.id}`} className="break-words font-medium text-pen hover:underline">
                  {c.name}
                </Link>
              ),
            },
            { key: "city", header: "Ort", mobile: "meta", cell: (c) => <span className="text-ink-soft">{c.city}</span> },
            { key: "type", header: "Typ", mobile: "meta", cell: (c) => <span className="text-ink-soft">{c.type === "BUSINESS" ? "B2B" : "B2C"}</span> },
            {
              key: "contact",
              header: "Standardkontakt",
              mobile: "hidden",
              cell: (c) => <span className="text-ink-soft">{c.contacts[0] ? `${c.contacts[0].firstName} ${c.contacts[0].lastName}` : "—"}</span>,
            },
            { key: "vat", header: "USt-IdNr.", mobile: "hidden", cell: (c) => <span className="text-ink-muted">{c.vatId ?? "—"}</span> },
            {
              key: "action",
              header: "Aktion",
              align: "right",
              mobile: "meta",
              cell: (c) => (
                <ArchiveCustomerButton id={c.id} name={c.name} />
              ),
            },
          ]}
        />
        <Pagination basePath="/kunden" searchParams={{ q: query, archiviert: input.archiviert }} total={page.total} limit={page.limit} offset={page.offset} />
      </div>
    </div>
  );
}
