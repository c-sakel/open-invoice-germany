import Link from "next/link";
import { z } from "zod";
import { PageHeader } from "@/components/PageHeader";
import { getActiveOrg } from "@/lib/org";
import { dbInternal } from "@/lib/db";
import { listInvoices, invoiceStatusTabCounts, invoiceListHeadline } from "@/domain/invoice/list";
import { availableActions } from "@/domain/document/actions";
import { listPaymentMethods } from "@/domain/payment-method/manage";
import { resolveDefaultPaymentMethodCode } from "@/domain/payment-method/default";
import { loadDocumentSettings } from "@/domain/document/settings";
import { formatCents } from "@/lib/money";
import { StatusBadge } from "@/components/StatusBadge";
import { FilterBar, type FilterField } from "@/components/list/FilterBar";
import { Pagination } from "@/components/list/Pagination";
import { RowActionsMenu } from "@/components/list/RowActionsMenu";
import { StatusTabs } from "@/components/list/StatusTabs";
import { ListHeadline, type HeadlineItem } from "@/components/list/ListHeadline";
import { relativeDueLabel } from "@/lib/relative-date";
import { originsFor } from "@/domain/document/origin";
import { parseListQuery } from "@/lib/list-query";
import { buildListeParam } from "@/domain/document/neighbors";
import { InvoiceListStatusFilter } from "@/schemas";

export const dynamic = "force-dynamic";

// Smoke-Bug-Fix (Fix-Welle Final-Review, Phase 12b) — analog invoice-view-model.ts TYPE_TITLE.
const TYPE_LABEL: Record<string, string> = {
  INVOICE: "Rechnung",
  CREDIT_NOTE: "Stornorechnung",
  CORRECTION: "Rechnungskorrektur",
  PARTIAL: "Teilrechnung",
  DOWNPAYMENT: "Abschlagsrechnung",
  FINAL: "Schlussrechnung",
};

// Beschriftung der Status-Tabs (Phase 13a, Task 8) — ersetzt das bisherige Status-<select>
// (STATUS_OPTIONS) in `fields`: der Status wird jetzt ausschliesslich ueber StatusTabs
// gewaehlt, nicht mehr doppelt ueber Tabs UND Filterleiste.
const STATUS_TAB_LABEL: Record<InvoiceListStatusFilter, string> = {
  all: "Alle",
  draft: "Entwurf",
  open: "Offen",
  due: "Fällig heute",
  overdue: "Überfällig",
  partial: "Teilbezahlt",
  paid: "Bezahlt",
  cancelled: "Storniert",
};

function deDate(d: Date | null) {
  return d ? new Intl.DateTimeFormat("de-DE").format(d) : "—";
}

/** Filterwerte ohne `status` (Task 8, Brief): die Tab-Zaehler gelten fuer JEDEN Tab
 *  gleichermassen — `invoiceStatusTabCounts` ignoriert `filter.status` zwar ohnehin
 *  (siehe invoiceFilterConditions), das Weglassen macht die Absicht im Code sichtbar. */
function withoutStatus(filter: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...filter };
  delete rest.status;
  return rest;
}

/**
 * Liste, Tabs und Kopfkennzahlen in EINEM Promise.all (Task-8-Brief) — alle drei teilen
 * denselben `now` (sonst zeigt die Liste nachts zwei Stunden ein anderes "ueberfaellig"
 * als die Tabs/Kennzahlen). Bei ungueltiger Handeingabe der URL (z. B. `offset=abc`) faengt
 * `loadListPage` das bislang nur fuer die Liste ab (Fix-Welle B1) — hier fuer alle drei
 * gemeinsam: ein ZodError laesst alle drei mit den Standardfiltern erneut laufen, statt die
 * Next.js-Fehlerseite zu zeigen.
 */
async function loadOverview(orgId: string, rawFilter: Record<string, unknown>, now: Date) {
  try {
    return await Promise.all([
      listInvoices(orgId, rawFilter, now),
      invoiceStatusTabCounts(orgId, withoutStatus(rawFilter), now),
      invoiceListHeadline(orgId, rawFilter, now),
    ]);
  } catch (e) {
    if (!(e instanceof z.ZodError)) throw e;
    return Promise.all([listInvoices(orgId, {}, now), invoiceStatusTabCounts(orgId, {}, now), invoiceListHeadline(orgId, {}, now)]);
  }
}

type SP = Record<string, string | string[] | undefined>;

export default async function RechnungenPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const values: Record<string, string | undefined> = {
    q: firstOf(sp.q),
    status: firstOf(sp.status),
    type: firstOf(sp.type),
    customerId: firstOf(sp.customerId),
    minCents: firstOf(sp.minCents),
    maxCents: firstOf(sp.maxCents),
    paymentMethodId: firstOf(sp.paymentMethodId),
    eInvoice: firstOf(sp.eInvoice),
    from: firstOf(sp.from),
    to: firstOf(sp.to),
    offset: firstOf(sp.offset),
  };
  const liste = buildListeParam(values);
  const detailHref = (id: string) => `/rechnungen/${id}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;

  const org = await getActiveOrg();
  const now = new Date();
  // Fix-Welle (B1): rohe searchParams enthalten bei jedem FilterBar-Submit leere Strings
  // ("Alle" im <select>) — parseListQuery entfernt sie, ein verbleibender ZodError
  // (handgeschriebene URL, z. B. offset=abc) faengt loadOverview ab statt die Seite
  // abstuerzen zu lassen.
  const rawFilter = parseListQuery(sp, ["eInvoice"]);

  const [[result, tabCounts, headline], allPaymentMethods, docSettings, customerOptions] = await Promise.all([
    loadOverview(org.id, rawFilter, now),
    listPaymentMethods(org.id),
    loadDocumentSettings(org.id),
    dbInternal.customer.findMany({ where: { orgId: org.id, isArchived: false }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const activePaymentMethods = allPaymentMethods.filter((m) => m.isActive && m.code !== "SKONTO");
  const paymentMethodOptions = activePaymentMethods.map((m) => ({ code: m.code, name: m.name }));

  // Fix-Runde 1 (Ruling c): Zahlungsart-Vorbelegung je Zeile ueber Kunden-Standard ->
  // Org-Standard -> erste aktive Methode (resolveDefaultPaymentMethodCode) — NICHT mehr
  // hartkodiert die erste aktive Methode der Organisation fuer alle Zeilen. Ein
  // zusaetzlicher Bulk-Query fuer die Kunden-Standardmethoden der aktuellen Seite (kein
  // N+1) statt eines Joins je Zeile.
  const orgDefaultCode = docSettings.defaultPaymentMethodId
    ? (allPaymentMethods.find((m) => m.id === docSettings.defaultPaymentMethodId)?.code ?? null)
    : null;
  const customerIds = [...new Set(result.rows.map((r) => r.customerId))];
  const customerDefaults = await dbInternal.customer.findMany({
    where: { orgId: org.id, id: { in: customerIds } },
    select: { id: true, defaultPaymentMethod: { select: { code: true } } },
  });
  const customerDefaultCodeById = new Map(customerDefaults.map((c) => [c.id, c.defaultPaymentMethod?.code ?? null]));

  // Herkunft je Zeile (Task 2/8): eine Bulk-Abfrage fuer die gesamte Seite statt N+1.
  const ids = result.rows.map((r) => r.id);
  const origins = await originsFor(org.id, "INVOICE", ids);

  const headlineItems: HeadlineItem[] = [
    { label: "Belege", value: String(headline.count) },
    {
      label: "Brutto gesamt",
      value: formatCents(headline.grossCents, headline.currency),
      hint: headline.mixedCurrency ? "gemischte Währungen" : undefined,
    },
    {
      label: "Offen",
      value: formatCents(headline.openCents, headline.currency),
      hint: headline.mixedCurrency ? "gemischte Währungen" : undefined,
    },
    {
      label: "Überfällig",
      value: formatCents(headline.overdueCents, headline.currency),
      tone: "danger",
      hint: headline.mixedCurrency ? "gemischte Währungen" : undefined,
    },
  ];

  const statusTabs = InvoiceListStatusFilter.options.map((value) => ({ value, label: STATUS_TAB_LABEL[value], count: tabCounts[value] }));

  const fields: FilterField[] = [
    { type: "text", name: "q", label: "Suche", placeholder: "Nummer, Kunde, Position…" },
    {
      type: "select",
      name: "type",
      label: "Typ",
      options: Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label })),
    },
    { type: "combo", name: "customerId", label: "Kunde", options: customerOptions.map((c) => ({ value: c.id, label: c.name })) },
    { type: "number", name: "minCents", label: "Betrag von", placeholder: "0,00" },
    { type: "number", name: "maxCents", label: "Betrag bis", placeholder: "0,00" },
    {
      type: "select",
      name: "paymentMethodId",
      label: "Zahlungsart",
      options: allPaymentMethods.filter((m) => m.code !== "SKONTO").map((m) => ({ value: m.id, label: m.name })),
    },
    {
      type: "select",
      name: "eInvoice",
      label: "E-Rechnung",
      options: [
        { value: "true", label: "Ja" },
        { value: "false", label: "Nein" },
      ],
    },
    { type: "date", name: "from", label: "Von" },
    { type: "date", name: "to", label: "Bis" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={values.type === "CREDIT_NOTE" ? "Gutschriften" : "Rechnungen"}
        subtitle={`${result.total} Belege`}
        actions={
          <Link href="/rechnungen/neu" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            Neue Rechnung
          </Link>
        }
      />

      <StatusTabs basePath="/rechnungen" searchParams={values} tabs={statusTabs} active={values.status ?? "all"} />

      <FilterBar basePath="/rechnungen" fields={fields} values={values} />

      <ListHeadline items={headlineItems} />

      {result.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          Keine Rechnungen gefunden.{" "}
          <Link href="/rechnungen/neu" className="font-medium text-indigo-600 hover:underline">
            Lege deine erste Rechnung an.
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Nummer</th>
                <th className="px-4 py-3">Typ</th>
                <th className="px-4 py-3">Kunde</th>
                <th className="px-4 py-3">Fällig</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Brutto</th>
                <th className="px-4 py-3 text-right">Offen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {result.rows.map((inv) => {
                const actions = availableActions({
                  kind: "INVOICE",
                  type: inv.type,
                  status: inv.effectiveStatus,
                  isDraft: inv.effectiveStatus === "DRAFT",
                  hasEmailLog: inv.hasEmailLog,
                  dunningState: inv.dunningState,
                });
                const due = relativeDueLabel(inv.dueDate, now);
                const origin = origins.get(inv.id);
                return (
                  <tr key={inv.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link href={detailHref(inv.id)} className="font-medium text-indigo-600 hover:underline">
                        {inv.number ?? "Entwurf"}
                      </Link>
                      {origin && (
                        <div>
                          <Link href={origin.href} className="text-xs text-slate-400 hover:text-slate-600 hover:underline">
                            {origin.label}
                          </Link>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{TYPE_LABEL[inv.type] ?? inv.type}</td>
                    <td className="px-4 py-3 text-slate-600">{inv.customerName}</td>
                    <td className="px-4 py-3">
                      <span title={deDate(inv.dueDate)} className={due.overdue ? "text-rose-700" : "text-slate-600"}>
                        {due.text}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={inv.effectiveStatus} partiallyPaid={inv.partiallyPaid} />
                    </td>
                    <td className="tabular px-4 py-3 text-right font-medium">{formatCents(inv.grossTotalCents, inv.currency)}</td>
                    <td className="tabular px-4 py-3 text-right text-slate-600">{formatCents(inv.openCents, inv.currency)}</td>
                    <td className="px-4 py-3 text-right">
                      <RowActionsMenu
                        kind="INVOICE"
                        id={inv.id}
                        actions={actions}
                        openHref={`/rechnungen/${inv.id}`}
                        editHref={inv.effectiveStatus === "DRAFT" ? `/rechnungen/${inv.id}/bearbeiten` : undefined}
                        pdfHref={`/api/invoices/${inv.id}/pdf`}
                        xrechnungHref={`/api/invoices/${inv.id}/xrechnung`}
                        emailDocType={inv.type === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE"}
                        hasEmailLog={inv.hasEmailLog}
                        duplicateRoute={`/api/invoices/${inv.id}/duplicate`}
                        duplicateRedirect="/rechnungen/{id}/bearbeiten"
                        cancelRoute={`/api/invoices/${inv.id}/cancel`}
                        dunningRoute={`/api/invoices/${inv.id}/dunning`}
                        dunningCount={inv.dunningCount}
                        payment={
                          inv.openCents > 0
                            ? {
                                openCents: inv.openCents,
                                methods: paymentMethodOptions,
                                defaultMethod: resolveDefaultPaymentMethodCode({
                                  customerDefaultCode: customerDefaultCodeById.get(inv.customerId),
                                  orgDefaultCode,
                                  activeMethods: paymentMethodOptions,
                                }),
                              }
                            : undefined
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination basePath="/rechnungen" searchParams={values} total={result.total} limit={result.limit} offset={result.offset} />
        </div>
      )}
    </div>
  );
}

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
