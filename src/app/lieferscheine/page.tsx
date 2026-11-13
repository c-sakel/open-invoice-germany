import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CsvLink } from "@/components/ui/CsvLink";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import {
  listDeliveryNotes,
  deliveryNoteStatusTabCounts,
  deliveryNoteListHeadline,
  type DeliveryNoteListResult,
  type DeliveryNoteListRow,
  type DeliveryNoteListHeadline,
} from "@/domain/document/list";
import { availableActions } from "@/domain/document/actions";
import { applyCustomerComboFilter } from "@/domain/customer/list";
import { listTags } from "@/domain/tag/manage";
import { tagsForDocuments } from "@/domain/tag/list";
import { TagChips } from "@/components/tags/TagChips";
import { StatusBadge } from "@/components/StatusBadge";
import { FilterBar, type FilterField } from "@/components/list/FilterBar";
import { Pagination } from "@/components/list/Pagination";
import { RowActionsMenu } from "@/components/list/RowActionsMenu";
import { StatusTabs, type StatusTab } from "@/components/list/StatusTabs";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
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
    tag: firstOf(sp.tag),
    offset: firstOf(sp.offset),
  };
  const liste = buildListeParam(values);
  const detailHref = (id: string) => `/lieferscheine/${id}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;

  const org = await getActiveOrg();
  const rawFilter = parseListQuery(sp);

  const [customerOptions, , tags] = await Promise.all([
    // Fix-Welle S3: `take: 500` (Spec: „bis zu 500 Kunden") — ohne Begrenzung laedt jeder
    // Seitenaufruf ALLE nicht archivierten Kunden der Organisation in die <datalist>.
    dbInternal.customer.findMany({ where: { orgId: org.id, isArchived: false }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    // Fix-Welle M2: `customerId` kann ein getippter Kundenname statt einer Id sein — auf
    // einen exakten Treffer aufloesen, sonst faellt der Rohtext auf `q` zurueck (Spec).
    applyCustomerComboFilter(org.id, rawFilter),
    // Phase 13d, Task 4: Tag-Filteroptionen (FilterBar-Feld "tag").
    listTags(org.id),
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
  const [origins, tagsByDocId] = await Promise.all([originsFor(org.id, "DELIVERY_NOTE", ids), tagsForDocuments(org.id, "DELIVERY_NOTE", ids)]);

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
    // Phase 13d, Task 4: Tag-Filter — Aufloesung in listDeliveryNotes (docIdsForTag).
    { type: "select", name: "tag", label: "Tag", options: tags.map((t) => ({ value: t.id, label: t.name })) },
  ];

  const headlineItems: HeadlineItem[] = [{ label: "Belege", value: String(headline.count) }];

  const columns: DataColumn<DeliveryNoteListRow>[] = [
    {
      key: "number",
      header: "Nummer",
      mobile: "title",
      cell: (n) => {
        const origin = origins.get(n.id);
        const rowTags = tagsByDocId.get(n.id) ?? [];
        return (
          <>
            <Link href={detailHref(n.id)} className="font-medium text-pen hover:underline">
              {n.number ?? "(Entwurf)"}
            </Link>
            {origin && (
              <span className="block">
                <Link href={origin.href} className="text-xs text-ink-muted hover:text-ink-soft hover:underline">
                  {origin.label}
                </Link>
              </span>
            )}
            {rowTags.length > 0 && (
              <span className="mt-1 block">
                <TagChips tags={rowTags} size="xs" />
              </span>
            )}
          </>
        );
      },
    },
    { key: "customer", header: "Kunde", mobile: "meta", cell: (n) => <span className="break-words text-ink-soft">{n.customerName}</span> },
    { key: "date", header: "Belegdatum", mobile: "meta", cell: (n) => <span className="text-ink-soft">{deDate(n.issueDate)}</span> },
    {
      key: "status",
      header: "Status",
      mobile: "meta",
      cell: (n) => (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusBadge status={n.status} />
          {n.archivedAt && <span className="text-xs text-ink-muted">archiviert</span>}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Aktionen",
      align: "right",
      mobile: "meta",
      cell: (n) => {
        const actions = availableActions({
          kind: "DELIVERY_NOTE",
          type: "DELIVERY_NOTE",
          status: n.status,
          isDraft: n.status === "DRAFT",
          hasEmailLog: n.hasEmailLog,
        });
        return (
          <RowActionsMenu
            kind="DELIVERY_NOTE"
            id={n.id}
            actions={actions}
            openHref={`/lieferscheine/${n.id}`}
            editHref={n.status === "DRAFT" ? `/lieferscheine/${n.id}/bearbeiten` : undefined}
            pdfHref={`/api/delivery-notes/${n.id}/pdf`}
            emailDocType="DELIVERY_NOTE"
            hasEmailLog={n.hasEmailLog}
            duplicateRoute={`/api/delivery-notes/${n.id}/duplicate`}
            duplicateRedirect="/lieferscheine/{id}"
            cancelRoute={`/api/delivery-notes/${n.id}/status`}
            cancelBody={{ action: "CANCEL" }}
            cancelInfo={{ noun: "Lieferschein", number: n.number }}
            templateName={n.number ?? undefined}
          />
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lieferscheine"
        subtitle={`${result.total} Belege`}
        actions={
          <>
            <CsvLink href={"/api/exports/lieferscheine.csv" + (liste ? "?" + liste : "")} what="Lieferscheine" />
            <Link href="/lieferscheine/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
              Neuer Lieferschein
            </Link>
          </>
        }
      />
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">Kein Steuerbeleg — Nachweis des Leistungszeitpunkts.</p>
        <Link href={showArchived ? "/lieferscheine" : "/lieferscheine?archiviert=1"} className="text-sm font-medium text-pen hover:underline">
          {showArchived ? "Archivierte ausblenden" : "Archivierte anzeigen"}
        </Link>
      </div>

      <StatusTabs basePath="/lieferscheine" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/lieferscheine" fields={fields} values={values} />

      <ListHeadline items={headlineItems} />

      <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
        <DataTable
          caption="Lieferscheine"
          rows={result.rows}
          rowKey={(n) => n.id}
          empty={{ text: "Keine Lieferscheine gefunden.", action: { label: "Ersten Lieferschein anlegen", href: "/lieferscheine/neu" } }}
          columns={columns}
        />
        <Pagination basePath="/lieferscheine" searchParams={values} total={result.total} limit={result.limit} offset={result.offset} />
      </div>
    </div>
  );
}
