import Link from "next/link";
import { z } from "zod";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { listRecurring, recurringStatusTabCounts, type RecurringListResult } from "@/domain/document/list";
import { availableActions } from "@/domain/document/actions";
import { FilterBar, type FilterField } from "@/components/list/FilterBar";
import { Pagination } from "@/components/list/Pagination";
import { RowActionsMenu } from "@/components/list/RowActionsMenu";
import { StatusTabs, type StatusTab } from "@/components/list/StatusTabs";
import { parseListQuery } from "@/lib/list-query";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  ACTIVE: { text: "aktiv", cls: "bg-emerald-100 text-emerald-800" },
  PAUSED: { text: "pausiert", cls: "bg-amber-100 text-amber-800" },
  ENDED: { text: "beendet", cls: "bg-slate-200 text-slate-600" },
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
  // Filterwerte ohne `status` fuer die Tab-Zaehler (siehe rechnungen/page.tsx `withoutStatus`).
  const tabFilter = { ...rawFilter };
  delete tabFilter.status;

  const customerOptions = await dbInternal.customer.findMany({
    where: { orgId: org.id, isArchived: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  let result: RecurringListResult;
  let tabCounts: Record<"all" | "ACTIVE" | "PAUSED" | "ENDED", number>;
  try {
    [result, tabCounts] = await Promise.all([listRecurring(org.id, rawFilter), recurringStatusTabCounts(org.id, tabFilter)]);
  } catch (e) {
    if (!(e instanceof z.ZodError)) throw e;
    [result, tabCounts] = await Promise.all([listRecurring(org.id, {}), recurringStatusTabCounts(org.id, {})]);
  }

  const statusTabs: StatusTab[] = (["all", "ACTIVE", "PAUSED", "ENDED"] as const).map((value) => ({
    value,
    label: STATUS_TAB_LABEL[value],
    count: tabCounts[value],
  }));

  const fields: FilterField[] = [
    { type: "text", name: "q", label: "Suche", placeholder: "Bezeichnung, Kunde…" },
    { type: "combo", name: "customerId", label: "Kunde", options: customerOptions.map((c) => ({ value: c.id, label: c.name })) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Abos / Wiederkehrende Rechnungen"
        subtitle={`${result.total} Belege`}
        actions={
          <Link href="/abos/neu" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            Neues Abo
          </Link>
        }
      />
      <p className="text-sm text-slate-500">
        Vorlagen, aus denen automatisch Rechnungen erzeugt werden — wöchentlich bis jährlich. Erzeugte Rechnungen durchlaufen Festschreibung,
        Nummernkreis und Audit wie jede andere Rechnung.
      </p>

      <StatusTabs basePath="/abos" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/abos" fields={fields} values={values} />

      {result.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          Keine Abos gefunden.{" "}
          <Link href="/abos/neu" className="font-medium text-indigo-600 hover:underline">
            Lege dein erstes Abo an.
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Bezeichnung</th>
                <th className="px-4 py-3">Kunde</th>
                <th className="px-4 py-3">Nächste Rechnung</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((r) => {
                const s = STATUS_LABEL[r.status] ?? { text: r.status, cls: "bg-slate-100 text-slate-600" };
                const actions = availableActions({ kind: "RECURRING", type: "RECURRING", status: r.status, isDraft: false });
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={`/abos/${r.id}`} className="font-medium text-indigo-600 hover:underline">
                        {r.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.customerName}</td>
                    <td className="px-4 py-3 text-slate-600">{r.status === "ENDED" ? "—" : deDate(r.nextRunDate)}</td>
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
