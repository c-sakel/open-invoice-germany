import Link from "next/link";
import { z } from "zod";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { listQuotes, quoteStatusTabCounts, quoteListHeadline, type QuoteListResult, type QuoteListHeadline } from "@/domain/document/list";
import { availableActions, convertTargets } from "@/domain/document/actions";
import { billingStateIndex } from "@/domain/document/billing-state";
import { formatCents } from "@/lib/money";
import { StatusBadge, BillingStateBadge } from "@/components/StatusBadge";
import { FilterBar, type FilterField } from "@/components/list/FilterBar";
import { Pagination } from "@/components/list/Pagination";
import { RowActionsMenu } from "@/components/list/RowActionsMenu";
import { StatusTabs, type StatusTab } from "@/components/list/StatusTabs";
import { ListHeadline, type HeadlineItem } from "@/components/list/ListHeadline";
import { parseListQuery } from "@/lib/list-query";
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
    offset: firstOf(sp.offset),
  };
  const liste = buildListeParam(values);
  const detailHref = (id: string) => `/dokumente/${id}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;

  const org = await getActiveOrg();
  const now = new Date();
  const rawFilter = parseListQuery(sp);

  // billingStateIndex laeuft VOR der Liste, weil er fuer drei Dinge gebraucht wird: ob die
  // zwei abgeleiteten Tabs ueberhaupt angeboten werden (Brief, Step 2), die `id`-Liste fuer
  // "?status=billed"/"?status=partially-billed" (Task-5-Kommentar zu `quoteStatusWhere`) und
  // den Zeilen-Chip — `cache()` memoisiert ihn je Request, ein zweiter Aufruf innerhalb von
  // `quoteStatusTabCounts` unten kostet also keine zusaetzliche Abfrage.
  const [index, customerOptions] = await Promise.all([
    billingStateIndex(org.id),
    dbInternal.customer.findMany({ where: { orgId: org.id, isArchived: false }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const billedIds: string[] = [];
  const partiallyBilledIds: string[] = [];
  for (const [quoteId, state] of index.states) {
    if (state === "FULL") billedIds.push(quoteId);
    else if (state === "PARTIAL") partiallyBilledIds.push(quoteId);
  }

  // Seiten-Wiring (Task 8, wie in Task 5 vorgesehen): "billed"/"partially-billed" sind kein
  // Beleg-Status — vor dem Aufruf von `listQuotes`/`quoteListHeadline` in `status: "all"` +
  // einen genuinen `ids`-Funktionsparameter (aus dem Index) uebersetzt, statt
  // `quoteStatusWhere` um einen zweiten Statusbegriff zu erweitern ODER `ids` dem
  // oeffentlich genutzten `quoteListFilterSchema` hinzuzufuegen (das waere ein neuer,
  // ungewollter Query-Parameter der `/api/v1/Quote`-/`/api/v1/OrderConfirmation`-Routen).
  const listFilter: Record<string, unknown> = { ...rawFilter, includeArchived: showArchived };
  const idsOpt: { ids?: string[] } = {};
  if (values.status === "billed") {
    listFilter.status = "all";
    idsOpt.ids = billedIds;
  } else if (values.status === "partially-billed") {
    listFilter.status = "all";
    idsOpt.ids = partiallyBilledIds;
  }
  const tabFilter = { ...withoutStatus(rawFilter), includeArchived: showArchived };

  let result: QuoteListResult;
  let tabCounts: Record<string, number | null>;
  let headline: QuoteListHeadline;
  try {
    [result, tabCounts, headline] = await Promise.all([
      listQuotes(org.id, listFilter, now, idsOpt),
      quoteStatusTabCounts(org.id, tabFilter, now),
      quoteListHeadline(org.id, listFilter, now, idsOpt),
    ]);
  } catch (e) {
    if (!(e instanceof z.ZodError)) throw e;
    const fallback = { includeArchived: showArchived };
    [result, tabCounts, headline] = await Promise.all([
      listQuotes(org.id, fallback, now),
      quoteStatusTabCounts(org.id, fallback, now),
      quoteListHeadline(org.id, fallback, now),
    ]);
  }
  const rows = result.rows;

  const statusTabValues = index.available ? (["all", ...QuoteStatus.options, "billed", "partially-billed"] as const) : (["all", ...QuoteStatus.options] as const);
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
    { type: "combo", name: "customerId", label: "Kunde", options: customerOptions.map((c) => ({ value: c.id, label: c.name })) },
    {
      type: "select",
      name: "kind",
      label: "Art",
      options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })),
    },
    { type: "date", name: "from", label: "Von" },
    { type: "date", name: "to", label: "Bis" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dokumente"
        subtitle={`${result.total} Belege`}
        actions={
          <Link href="/dokumente/neu" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            Neues Dokument
          </Link>
        }
      />
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">Angebote, Auftragsbestätigungen und Proforma-Rechnungen — keine Steuerbelege; jederzeit in eine Rechnung umwandelbar.</p>
        <Link href={showArchived ? "/dokumente" : "/dokumente?archiviert=1"} className="text-sm font-medium text-indigo-600 hover:underline">
          {showArchived ? "Archivierte ausblenden" : "Archivierte anzeigen"}
        </Link>
      </div>

      <StatusTabs basePath="/dokumente" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/dokumente" fields={fields} values={values} />

      <ListHeadline items={headlineItems} />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          Keine Dokumente gefunden.{" "}
          <Link href="/dokumente/neu" className="font-medium text-indigo-600 hover:underline">
            Lege dein erstes Angebot an.
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Nummer</th>
                <th className="px-4 py-3">Art</th>
                <th className="px-4 py-3">Kunde</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Brutto</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((d) => {
                const actions = availableActions({
                  kind: "QUOTE",
                  type: d.kind,
                  status: d.effectiveStatus,
                  isDraft: d.effectiveStatus === "DRAFT",
                  hasEmailLog: d.hasEmailLog,
                });
                // Nachtrag Punkt 1: convertedToInvoiceId/billingFull an convertTargets, damit
                // CONVERT im Zeilenmenue erscheint — der alte "Lieferschein erzeugen"-Eintrag
                // in RowActionsMenu ist mit `!convert` bewacht, es entsteht kein Doppeleintrag.
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
                  <tr key={d.id} className={`hover:bg-slate-50 ${d.archivedAt ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3">
                      <Link href={detailHref(d.id)} className="font-medium text-indigo-600 hover:underline">
                        {d.number ?? "—"}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{KIND_LABEL[d.kind] ?? d.kind}</td>
                    <td className="px-4 py-3 text-slate-600">{d.customerName}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={d.effectiveStatus} />
                      {d.kind !== "PROFORMA" && <BillingStateBadge state={billingState} />}
                      {d.archivedAt && <span className="ml-2 text-xs text-slate-400">archiviert</span>}
                    </td>
                    <td className="tabular px-4 py-3 text-right font-medium">{formatCents(d.grossTotalCents, d.currency)}</td>
                    <td className="px-4 py-3 text-right">
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
                        convert={convert}
                        documentActions={{ type: "QUOTE", status: d.effectiveStatus, archived: d.archivedAt !== null }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination basePath="/dokumente" searchParams={values} total={result.total} limit={result.limit} offset={result.offset} />
        </div>
      )}
    </div>
  );
}
