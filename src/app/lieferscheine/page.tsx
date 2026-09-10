import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import {
  listDeliveryNotes,
  deliveryNoteStatusTabCounts,
  deliveryNoteListHeadline,
  type DeliveryNoteListResult,
  type DeliveryNoteListHeadline,
} from "@/domain/document/list";
import { availableActions } from "@/domain/document/actions";
import { applyCustomerComboFilter } from "@/domain/customer/list";
import { StatusBadge } from "@/components/StatusBadge";
import { FilterBar, type FilterField } from "@/components/list/FilterBar";
import { Pagination } from "@/components/list/Pagination";
import { RowActionsMenu } from "@/components/list/RowActionsMenu";
import { StatusTabs, type StatusTab } from "@/components/list/StatusTabs";
import { ListHeadline, type HeadlineItem } from "@/components/list/ListHeadline";
import { originsFor } from "@/domain/document/origin";
import { parseListQuery, runListFilter } from "@/lib/list-query";
import { buildListeParam } from "@/domain/document/neighbors";
import { DeliveryNoteStatus } from "@/schemas";

export const dynamic = "force-dynamic";

const STATUS_TAB_LABEL: Record<string, string> = {
  all: "Alle",
  DRAFT: "Entwurf",
  CREATED: "Erstellt",
  SENT: "Versendet",
  DELIVERED: "Geliefert",
  CANCELLED: "Storniert",
};

function deDate(d: Date | null) {
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "—";
}

type SP = Record<string, string | string[] | undefined>;

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function LieferscheinePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const showArchived = firstOf(sp.archiviert) === "1";
  const values: Record<string, string | undefined> = {
    q: firstOf(sp.q),
    status: firstOf(sp.status),
    customerId: firstOf(sp.customerId),
    from: firstOf(sp.from),
    to: firstOf(sp.to),
    archiviert: firstOf(sp.archiviert),
    offset: firstOf(sp.offset),
  };
  const liste = buildListeParam(values);
  const detailHref = (id: string) => `/lieferscheine/${id}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;

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
  // erst als letzte Sicherung die volle Rueckstellung auf `{ includeArchived }`.
  const [result, tabCounts, headline] = await runListFilter<[DeliveryNoteListResult, Record<"all" | DeliveryNoteStatus, number>, DeliveryNoteListHeadline]>(
    rawFilter,
    (f) => {
      const listFilter: Record<string, unknown> = { ...f, includeArchived: showArchived };
      // Filterwerte ohne `status` fuer die Tab-Zaehler (siehe rechnungen/page.tsx `withoutStatus`).
      const tabFilter = { ...listFilter };
      delete tabFilter.status;
      return Promise.all([listDeliveryNotes(org.id, listFilter), deliveryNoteStatusTabCounts(org.id, tabFilter), deliveryNoteListHeadline(org.id, listFilter)]);
    },
    { includeArchived: showArchived },
  );

  // Herkunft je Zeile (Task 2/8): eine Bulk-Abfrage fuer die gesamte Seite statt N+1.
  const ids = result.rows.map((r) => r.id);
  const origins = await originsFor(org.id, "DELIVERY_NOTE", ids);

  const statusTabs: StatusTab[] = (["all", ...DeliveryNoteStatus.options] as const).map((value) => ({
    value,
    label: STATUS_TAB_LABEL[value] ?? value,
    count: tabCounts[value],
  }));

  const fields: FilterField[] = [
    { type: "text", name: "q", label: "Suche", placeholder: "Nummer, Kunde…" },
    {
      type: "combo",
      name: "customerId",
      label: "Kunde",
      options: customerOptions.map((c) => ({ value: c.id, label: c.name })),
      // Fix-Welle S2: zeigt den Kundennamen statt der rohen Id, wenn `?customerId=<cuid>`
      // ueber einen Link/ein Lesezeichen vorbelegt wurde.
      displayValue: customerOptions.find((c) => c.id === values.customerId)?.name,
    },
    { type: "date", name: "from", label: "Von" },
    { type: "date", name: "to", label: "Bis" },
  ];

  const headlineItems: HeadlineItem[] = [{ label: "Belege", value: String(headline.count) }];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lieferscheine"
        subtitle={`${result.total} Belege`}
        actions={
          <Link href="/lieferscheine/neu" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            Neuer Lieferschein
          </Link>
        }
      />
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Kein Steuerbeleg — Nachweis des Leistungszeitpunkts.</p>
        <Link href={showArchived ? "/lieferscheine" : "/lieferscheine?archiviert=1"} className="text-sm font-medium text-indigo-600 hover:underline">
          {showArchived ? "Archivierte ausblenden" : "Archivierte anzeigen"}
        </Link>
      </div>

      <StatusTabs basePath="/lieferscheine" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/lieferscheine" fields={fields} values={values} />

      <ListHeadline items={headlineItems} />

      {result.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          Keine Lieferscheine gefunden.{" "}
          <Link href="/lieferscheine/neu" className="font-medium text-indigo-600 hover:underline">
            Lege den ersten Lieferschein an.
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Nummer</th>
                <th className="px-4 py-3">Kunde</th>
                <th className="px-4 py-3">Belegdatum</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((n) => {
                const actions = availableActions({
                  kind: "DELIVERY_NOTE",
                  type: "DELIVERY_NOTE",
                  status: n.status,
                  isDraft: n.status === "DRAFT",
                  hasEmailLog: n.hasEmailLog,
                });
                const origin = origins.get(n.id);
                return (
                  <tr key={n.id} className={`hover:bg-slate-50 ${n.archivedAt ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3">
                      <Link href={detailHref(n.id)} className="font-medium text-indigo-600 hover:underline">
                        {n.number ?? "(Entwurf)"}
                      </Link>
                      {origin && (
                        <div>
                          <Link href={origin.href} className="text-xs text-slate-400 hover:text-slate-600 hover:underline">
                            {origin.label}
                          </Link>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{n.customerName}</td>
                    <td className="px-4 py-3 text-slate-600">{deDate(n.issueDate)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={n.status} />
                      {n.archivedAt && <span className="ml-2 text-xs text-slate-400">archiviert</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RowActionsMenu
                        kind="DELIVERY_NOTE"
                        id={n.id}
                        actions={actions}
                        openHref={`/lieferscheine/${n.id}`}
                        // Keine Bearbeiten-Seite fuer Lieferscheine (vorbestehende Luecke,
                        // nicht Teil dieses Tasks) — EDIT wird trotz ActionKey nicht gerendert.
                        pdfHref={`/api/delivery-notes/${n.id}/pdf`}
                        emailDocType="DELIVERY_NOTE"
                        hasEmailLog={n.hasEmailLog}
                        duplicateRoute={`/api/delivery-notes/${n.id}/duplicate`}
                        duplicateRedirect="/lieferscheine/{id}"
                        cancelRoute={`/api/delivery-notes/${n.id}/status`}
                        cancelBody={{ action: "CANCEL" }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination basePath="/lieferscheine" searchParams={values} total={result.total} limit={result.limit} offset={result.offset} />
        </div>
      )}
    </div>
  );
}
