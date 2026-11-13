import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CsvLink } from "@/components/ui/CsvLink";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { listQuotes, quoteStatusTabCounts, quoteListHeadline, type QuoteListResult, type QuoteListHeadline } from "@/domain/document/list";
import { availableActions, convertTargets } from "@/domain/document/actions";
import { billingStateIndex, billingFilterIds } from "@/domain/document/billing-state";
import { applyCustomerComboFilter } from "@/domain/customer/list";
import { listTags } from "@/domain/tag/manage";
import { tagsForDocuments } from "@/domain/tag/list";
import { TagChips } from "@/components/tags/TagChips";
import { formatCents } from "@/lib/money";
import { StatusBadge, BillingStateBadge } from "@/components/StatusBadge";
import { FilterBar, type FilterField } from "@/components/list/FilterBar";
import { Pagination } from "@/components/list/Pagination";
import { RowActionsMenu } from "@/components/list/RowActionsMenu";
import { StatusTabs, type StatusTab } from "@/components/list/StatusTabs";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { ListHeadline, type HeadlineItem } from "@/components/list/ListHeadline";
import { parseListQuery, runListFilter } from "@/lib/list-query";
import { buildListeParam } from "@/domain/document/neighbors";
import { QuoteStatus } from "@/schemas";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  ANGEBOT: "Angebot",
  AUFTRAGSBESTAETIGUNG: "Auftragsbestätigung",
  PROFORMA: "Proforma",
};

// Beschriftung der Status-Tabs (Phase 13a, Task 8) — die zwei abgeleiteten Tabs (billed/
// partially-billed) bilden den ABRECHNUNGSSTAND ab (billingStateIndex, Task 5), keinen
// gespeicherten Beleg-Status — deshalb dieselben Labels wie BILLING_STATE_MAP
// (src/components/StatusBadge.tsx).
const STATUS_TAB_LABEL: Record<string, string> = {
  all: "Alle",
  DRAFT: "Entwurf",
  SENT: "Versendet",
  ACCEPTED: "Angenommen",
  REJECTED: "Abgelehnt",
  EXPIRED: "Abgelaufen",
  CANCELLED: "Storniert",
  billed: "Berechnet",
  "partially-billed": "Teilweise berechnet",
};

/** Filterwerte ohne `status` (siehe rechnungen/page.tsx) — hier zusaetzlich ZWINGEND: die
 *  beiden abgeleiteten Tabs "billed"/"partially-billed" sind KEIN gueltiger Wert von
 *  `quoteListFilterSchema.status` (nur die gespeicherten QuoteStatus-Werte) — ohne das
 *  Entfernen wuerfe `quoteStatusTabCounts` fuer diese beiden Werte einen ZodError. */
function withoutStatus(filter: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...filter };
  delete rest.status;
  return rest;
}

type SP = Record<string, string | string[] | undefined>;

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function DokumentePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const showArchived = firstOf(sp.archiviert) === "1";
  const values: Record<string, string | undefined> = {
    q: firstOf(sp.q),
    status: firstOf(sp.status),
    kind: firstOf(sp.kind),
    customerId: firstOf(sp.customerId),
    from: firstOf(sp.from),
    to: firstOf(sp.to),
    archiviert: firstOf(sp.archiviert),
    tag: firstOf(sp.tag),
    offset: firstOf(sp.offset),
  };
  const liste = buildListeParam(values);
  const detailHref = (id: string) => `/dokumente/${id}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;

  const org = await getActiveOrg();
  const now = new Date();
  const rawFilter = parseListQuery(sp);
  // Fix-Welle M2: `customerId` kann seit Fix M2 ein getippter Kundenname statt einer Id
  // sein (JS-freier Rueckfall/`FilterBar` bilden nicht mehr selbst ab) — hier auf einen
  // exakten Treffer aufloesen, sonst faellt der Rohtext auf `q` zurueck (Spec-Zusage).
  // Laeuft parallel zu `billingStateIndex`/`customerOptions` (unabhaengige Abfragen).

  // billingStateIndex laeuft VOR der Liste, weil er fuer zwei Dinge gebraucht wird: die
  // `id`-Liste fuer "?status=billed"/"?status=partially-billed" (Task-5-Kommentar zu
  // `quoteStatusWhere`) und den Zeilen-Chip (Phase 17c: ohne Obergrenze, beide Tabs immer) — `cache()` memoisiert ihn je Request, ein zweiter Aufruf innerhalb von
  // `quoteStatusTabCounts` unten kostet also keine zusaetzliche Abfrage.
  const [index, customerOptions, , tags] = await Promise.all([
    billingStateIndex(org.id),
    // Fix-Welle S3: `take: 500` (Spec: „bis zu 500 Kunden") — ohne Begrenzung laedt jeder
    // Seitenaufruf ALLE nicht archivierten Kunden der Organisation in die <datalist>.
    dbInternal.customer.findMany({ where: { orgId: org.id, isArchived: false }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    applyCustomerComboFilter(org.id, rawFilter),
    // Phase 13d, Task 4: Tag-Filteroptionen (FilterBar-Feld "tag").
    listTags(org.id),
  ]);
  // Seiten-Wiring (Task 8, wie in Task 5 vorgesehen): "billed"/"partially-billed" sind kein
  // Beleg-Status — vor dem Aufruf von `listQuotes`/`quoteListHeadline` in `status: "all"` +
  // einen genuinen `ids`-Funktionsparameter (aus dem Index) uebersetzt, statt
  // `quoteStatusWhere` um einen zweiten Statusbegriff zu erweitern ODER `ids` dem
  // oeffentlich genutzten `quoteListFilterSchema` hinzuzufuegen (das waere ein neuer,
  // ungewollter Query-Parameter der `/api/v1/Quote`-/`/api/v1/OrderConfirmation`-Routen).
  const idsOpt: { ids?: string[] } = {};
  if (values.status === "billed" || values.status === "partially-billed") idsOpt.ids = await billingFilterIds(org.id, values.status);

  // Fix-Welle S6: `runListFilter` versucht `rawFilter` zuerst vollstaendig, entfernt bei
  // einem ZodError NUR die beanstandeten Schluessel (statt alle Filter zu verwerfen) und
  // erst als letzte Sicherung die volle Rueckstellung auf `{ includeArchived }`.
  const [result, tabCounts, headline] = await runListFilter<[QuoteListResult, Record<string, number | null>, QuoteListHeadline]>(
    rawFilter,
    (f) => {
      const listFilter: Record<string, unknown> = { ...f, includeArchived: showArchived };
      if (values.status === "billed" || values.status === "partially-billed") listFilter.status = "all";
      const tabFilter = { ...withoutStatus(f), includeArchived: showArchived };
      return Promise.all([listQuotes(org.id, listFilter, now, idsOpt), quoteStatusTabCounts(org.id, tabFilter, now), quoteListHeadline(org.id, listFilter, now, idsOpt)]);
    },
    { includeArchived: showArchived },
  );
  const rows = result.rows;
  // Phase 13d, Task 4: Tag-Chips der Zeilen — ein Bulk-Query fuer die ganze Seite (kein N+1).
  const tagsByDocId = await tagsForDocuments(org.id, "QUOTE", rows.map((r) => r.id));

  const statusTabValues = ["all", ...QuoteStatus.options, "billed", "partially-billed"] as const;
  const statusTabs: StatusTab[] = statusTabValues.map((value) => ({ value, label: STATUS_TAB_LABEL[value] ?? value, count: tabCounts[value] ?? null }));

  const headlineItems: HeadlineItem[] = [
    { label: "Belege", value: String(headline.count) },
    {
      label: "Brutto gesamt",
      value: formatCents(headline.grossCents, headline.currency),
      hint: headline.mixedCurrency ? "gemischte Währungen" : undefined,
    },
  ];

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
    {
      type: "select",
      name: "kind",
      label: "Art",
      options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
    },
    { type: "date", name: "from", label: "Von" },
    { type: "date", name: "to", label: "Bis" },
    // Phase 13d, Task 4: Tag-Filter — Aufloesung in listQuotes (docIdsForTag).
    { type: "select", name: "tag", label: "Tag", options: tags.map((t) => ({ value: t.id, label: t.name })) },
  ];

  const columns: DataColumn<QuoteListResult["rows"][number]>[] = [
    {
      key: "number",
      header: "Nummer",
      mobile: "title",
      cell: (d) => {
        const rowTags = tagsByDocId.get(d.id) ?? [];
        return (
          <>
            <Link href={detailHref(d.id)} className="font-medium text-pen hover:underline">
              {d.number ?? "—"}
            </Link>
            {rowTags.length > 0 && (
              <span className="mt-1 block">
                <TagChips tags={rowTags} size="xs" />
              </span>
            )}
          </>
        );
      },
    },
    { key: "kind", header: "Art", mobile: "meta", cell: (d) => <span className="text-ink-soft">{KIND_LABEL[d.kind] ?? d.kind}</span> },
    { key: "customer", header: "Kunde", mobile: "meta", cell: (d) => <span className="break-words text-ink-soft">{d.customerName}</span> },
    {
      key: "status",
      header: "Status",
      mobile: "meta",
      cell: (d) => {
        const billingState = index.states.get(d.id) ?? "NONE";
        return (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge status={d.effectiveStatus} />
            {d.kind !== "PROFORMA" && <BillingStateBadge state={billingState} />}
            {d.archivedAt && <span className="text-xs text-ink-muted">archiviert</span>}
          </span>
        );
      },
    },
    { key: "gross", header: "Brutto", mobile: "amount", cell: (d) => <span className="font-medium">{formatCents(d.grossTotalCents, d.currency)}</span> },
    {
      key: "actions",
      header: "Aktionen",
      align: "right",
      mobile: "meta",
      cell: (d) => {
        const actions = availableActions({
          kind: "QUOTE",
          type: d.kind,
          status: d.effectiveStatus,
          isDraft: d.effectiveStatus === "DRAFT",
          hasEmailLog: d.hasEmailLog,
        });
        // Nachtrag Punkt 1: convertedToInvoiceId/billingFull an convertTargets, damit CONVERT im
        // Zeilenmenue erscheint — der alte "Lieferschein erzeugen"-Eintrag in RowActionsMenu ist
        // mit `!convert` bewacht, es entsteht kein Doppeleintrag.
        const billingState = index.states.get(d.id) ?? "NONE";
        const convert = convertTargets({
          kind: "QUOTE",
          type: d.kind,
          status: d.effectiveStatus,
          isDraft: d.effectiveStatus === "DRAFT",
          convertedToInvoiceId: d.convertedToInvoiceId,
          billingFull: billingState === "FULL",
        });
        return (
          <RowActionsMenu
            kind="QUOTE"
            id={d.id}
            actions={actions}
            openHref={`/dokumente/${d.id}`}
            editHref={d.effectiveStatus === "DRAFT" ? `/dokumente/${d.id}/bearbeiten` : undefined}
            pdfHref={`/api/documents/${d.id}/pdf`}
            emailDocType={d.kind as "ANGEBOT" | "AUFTRAGSBESTAETIGUNG" | "PROFORMA"}
            hasEmailLog={d.hasEmailLog}
            duplicateRoute={`/api/documents/${d.id}/duplicate`}
            duplicateRedirect="/dokumente/{id}"
            cancelRoute={`/api/documents/${d.id}/status`}
            cancelBody={{ action: "CANCEL" }}
            cancelInfo={{
              noun: KIND_LABEL[d.kind] ?? "Beleg",
              number: d.number,
              linkedInvoices: billingState !== "NONE" || d.convertedToInvoiceId !== null,
            }}
            convert={convert}
            documentActions={{ type: "QUOTE", status: d.effectiveStatus, archived: d.archivedAt !== null }}
            templateName={d.number ?? undefined}
          />
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dokumente"
        subtitle={`${result.total} Belege`}
        actions={
          <>
            <CsvLink href={"/api/exports/dokumente.csv" + (liste ? "?" + liste : "")} what="Dokumente" />
            <Link href="/dokumente/neu" className="rounded-md bg-pen px-4 py-2 text-sm font-medium text-on-accent hover:bg-pen-strong">
              Neues Dokument
            </Link>
          </>
        }
      />
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">Angebote, Auftragsbestätigungen und Proforma-Rechnungen — keine Steuerbelege; jederzeit in eine Rechnung umwandelbar.</p>
        <Link href={showArchived ? "/dokumente" : "/dokumente?archiviert=1"} className="text-sm font-medium text-pen hover:underline">
          {showArchived ? "Archivierte ausblenden" : "Archivierte anzeigen"}
        </Link>
      </div>

      <StatusTabs basePath="/dokumente" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/dokumente" fields={fields} values={values} />

      <ListHeadline items={headlineItems} />

      <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
        <DataTable
          caption="Dokumente"
          rows={rows}
          rowKey={(d) => d.id}
          empty={{ text: "Keine Dokumente gefunden.", action: { label: "Erstes Angebot anlegen", href: "/dokumente/neu" } }}
          columns={columns}
        />
        <Pagination basePath="/dokumente" searchParams={values} total={result.total} limit={result.limit} offset={result.offset} />
      </div>
    </div>
  );
}
