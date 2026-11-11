import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { listRecurring, recurringStatusTabCounts, type RecurringListResult } from "@/domain/document/list";
import { availableActions } from "@/domain/document/actions";
import { applyCustomerComboFilter } from "@/domain/customer/list";
import { FilterBar, type FilterField } from "@/components/list/FilterBar";
import { Pagination } from "@/components/list/Pagination";
import { RowActionsMenu } from "@/components/list/RowActionsMenu";
import { StatusTabs, type StatusTab } from "@/components/list/StatusTabs";
import { DataTable } from "@/components/ui/DataTable";
import { Card } from "@/components/ui/Card";
import { Kpi } from "@/components/ui/Kpi";
import { StatusBadge } from "@/components/StatusBadge";
import { loadDocumentSettings } from "@/domain/document/settings";
import { recurringRunRate } from "@/domain/reporting/recurring-run-rate";
import { formatCents } from "@/lib/money";
import { parseListQuery, runListFilter } from "@/lib/list-query";

export const dynamic = "force-dynamic";

const STATUS_TAB_LABEL: Record<string, string> = {
  all: "Alle",
  ACTIVE: "Aktiv",
  PAUSED: "Pausiert",
  ENDED: "Beendet",
};

function deDate(d: Date | null) {
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "—";
}

type SP = Record<string, string | string[] | undefined>;

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function AbosPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const values: Record<string, string | undefined> = {
    q: firstOf(sp.q),
    status: firstOf(sp.status),
    customerId: firstOf(sp.customerId),
    offset: firstOf(sp.offset),
  };

  const org = await getActiveOrg();
  const rawFilter = parseListQuery(sp);

  const [customerOptions] = await Promise.all([
    // Fix-Welle S3: `take: 500` (Spec: „bis zu 500 Kunden") — ohne Begrenzung laedt jeder
    // Seitenaufruf ALLE nicht archivierten Kunden der Organisation in die <datalist>.
    dbInternal.customer.findMany({ where: { orgId: org.id, isArchived: false }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    // Fix-Welle M2: `customerId` kann ein getippter Kundenname statt einer Id sein — auf
    // einen exakten Treffer aufloesen, sonst faellt der Rohtext auf `q` zurueck (Spec).
    applyCustomerComboFilter(org.id, rawFilter),
  ]);

  // Fix-Welle S6: `runListFilter` versucht `rawFilter` zuerst vollstaendig, entfernt bei
  // einem ZodError NUR die beanstandeten Schluessel (statt alle Filter zu verwerfen) und
  // erst als letzte Sicherung die volle Rueckstellung auf `{}`.
  const [result, tabCounts] = await runListFilter<[RecurringListResult, Record<"all" | "ACTIVE" | "PAUSED" | "ENDED", number>]>(rawFilter, (f) => {
    // Filterwerte ohne `status` fuer die Tab-Zaehler (siehe rechnungen/page.tsx `withoutStatus`).
    const tabFilter = { ...f };
    delete tabFilter.status;
    return Promise.all([listRecurring(org.id, f), recurringStatusTabCounts(org.id, tabFilter)]);
  });

  // G13: Run-Rate aktiver Abos; Standardwaehrung gross, weitere Waehrungen als Hinweis (nie Mischsumme).
  const [runRate, docSettings] = await Promise.all([recurringRunRate(org.id), loadDocumentSettings(org.id)]);
  const defaultCurrency = docSettings.defaultCurrency;
  const mainRate = runRate.find((r) => r.currency === defaultCurrency);
  const others = runRate.filter((r) => r.currency !== defaultCurrency);
  const hintParts = [
    ...others.map((r) => `+ ${formatCents(r.monthlyNetCents, r.currency)}`),
    ...(runRate.some((r) => r.skipped > 0) ? ["einzelne Abos mit unbekanntem Intervall nicht enthalten"] : []),
  ];
  const hint = hintParts.length > 0 ? hintParts.join(" · ") : undefined;

  const statusTabs: StatusTab[] = (["all", "ACTIVE", "PAUSED", "ENDED"] as const).map((value) => ({
    value,
    label: STATUS_TAB_LABEL[value],
    count: tabCounts[value],
  }));

  const fields: FilterField[] = [
    { type: "text", name: "q", label: "Suche", placeholder: "Bezeichnung, Kunde…" },
    {
      type: "combo",
      name: "customerId",
      label: "Kunde",
      options: customerOptions.map((c) => ({ value: c.id, label: c.name })),
      // Fix-Welle S2: zeigt den Kundennamen statt der rohen Id, wenn `?customerId=<cuid>`
      // ueber einen Link/ein Lesezeichen vorbelegt wurde.
      displayValue: customerOptions.find((c) => c.id === values.customerId)?.name,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Abos / Wiederkehrende Rechnungen"
        subtitle={`${result.total} Belege`}
        actions={
          <Link href="/abos/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
            Neues Abo
          </Link>
        }
      />
      <p className="text-sm text-ink-muted">
        Vorlagen, aus denen automatisch Rechnungen erzeugt werden — wöchentlich bis jährlich. Erzeugte Rechnungen durchlaufen Festschreibung,
        Nummernkreis und Audit wie jede andere Rechnung.
      </p>

      <Card>
        <Kpi
          label="Monatlich wiederkehrend (netto)"
          value={formatCents(mainRate?.monthlyNetCents ?? 0, defaultCurrency)}
          hint={hint}
        />
      </Card>

      <StatusTabs basePath="/abos" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/abos" fields={fields} values={values} />

      <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
        <DataTable
          caption="Abos"
          rows={result.rows}
          rowKey={(r) => r.id}
          empty={{ text: "Keine Abos gefunden.", action: { label: "Neu anlegen", href: "/abos/neu" } }}
          columns={[
            {
              key: "title",
              header: "Bezeichnung",
              mobile: "title",
              cell: (r) => (
                <Link href={`/abos/${r.id}`} className="break-words font-medium text-pen hover:underline">
                  {r.title}
                </Link>
              ),
            },
            { key: "customer", header: "Kunde", mobile: "meta", cell: (r) => <span className="break-words text-ink-soft">{r.customerName}</span> },
            {
              key: "next",
              header: "Nächste Rechnung",
              mobile: "meta",
              cell: (r) => <span className="text-ink-soft">{r.status === "ENDED" ? "—" : deDate(r.nextRunDate)}</span>,
            },
            { key: "status", header: "Status", mobile: "meta", cell: (r) => <StatusBadge status={r.status} /> },
            {
              key: "actions",
              header: "Aktionen",
              align: "right",
              mobile: "meta",
              cell: (r) => (
                <RowActionsMenu
                  kind="RECURRING"
                  id={r.id}
                  actions={availableActions({ kind: "RECURRING", type: "RECURRING", status: r.status, isDraft: false })}
                  openHref={`/abos/${r.id}`}
                  editHref={`/abos/${r.id}/bearbeiten`}
                />
              ),
            },
          ]}
        />
        <Pagination basePath="/abos" searchParams={values} total={result.total} limit={result.limit} offset={result.offset} />
      </div>
    </div>
  );
}
