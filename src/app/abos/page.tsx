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
import { parseListQuery, runListFilter } from "@/lib/list-query";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  ACTIVE: { text: "aktiv", cls: "bg-ledger/10 text-ledger" },
  PAUSED: { text: "pausiert", cls: "bg-seal/10 text-seal" },
  ENDED: { text: "beendet", cls: "bg-rule-strong text-ink-soft" },
};

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
          <Link href="/abos/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-white hover:bg-pen">
            Neues Abo
          </Link>
        }
      />
      <p className="text-sm text-ink-muted">
        Vorlagen, aus denen automatisch Rechnungen erzeugt werden — wöchentlich bis jährlich. Erzeugte Rechnungen durchlaufen Festschreibung,
        Nummernkreis und Audit wie jede andere Rechnung.
      </p>

      <StatusTabs basePath="/abos" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/abos" fields={fields} values={values} />

      {result.rows.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-dashed border-rule-strong bg-sheet p-10 text-center text-ink-muted">
          Keine Abos gefunden.{" "}
          <Link href="/abos/neu" className="font-medium text-pen hover:underline">
            Lege dein erstes Abo an.
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-rule bg-sheet">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3">Bezeichnung</th>
                <th className="px-4 py-3">Kunde</th>
                <th className="px-4 py-3">Nächste Rechnung</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {result.rows.map((r) => {
                const s = STATUS_LABEL[r.status] ?? { text: r.status, cls: "bg-well text-ink-soft" };
                const actions = availableActions({ kind: "RECURRING", type: "RECURRING", status: r.status, isDraft: false });
                return (
                  <tr key={r.id} className="hover:bg-paper">
                    <td className="px-4 py-3">
                      <Link href={`/abos/${r.id}`} className="font-medium text-pen hover:underline">
                        {r.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{r.customerName}</td>
                    <td className="px-4 py-3 text-ink-soft">{r.status === "ENDED" ? "—" : deDate(r.nextRunDate)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.text}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RowActionsMenu kind="RECURRING" id={r.id} actions={actions} openHref={`/abos/${r.id}`} editHref={`/abos/${r.id}/bearbeiten`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination basePath="/abos" searchParams={values} total={result.total} limit={result.limit} offset={result.offset} />
        </div>
      )}
    </div>
  );
}
