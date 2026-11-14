import Link from "next/link";
import { notFound } from "next/navigation";
import { getActiveOrg } from "@/lib/org";
import { customerOverview } from "@/domain/customer/overview";
import { NotFoundError } from "@/domain/errors";
import { monthlyRevenue } from "@/domain/reporting/revenue";
import { paymentBehaviour } from "@/domain/reporting/payment-behaviour";
import { CustomerTabs } from "@/components/customers/CustomerTabs";
import { VatCheckPanel } from "@/components/customers/VatCheckPanel";
import { listVatIdChecks } from "@/domain/customer/vat-check";
import { loadDocumentSettings } from "@/domain/document/settings";
import { resolveBuyerEndpoint } from "@/lib/einvoice/eas";
import { StatusBadge } from "@/components/StatusBadge";
import { StackedBar, type StackedSegment } from "@/components/charts/StackedBar";
import { CHART_COLORS } from "@/components/charts/types";
import { ResponsiveBarChart } from "@/components/dashboard/ResponsiveBarChart";
import { revenueWithPriorYear } from "@/components/dashboard/chart-data";
import { DataTable } from "@/components/ui/DataTable";
import { Card } from "@/components/ui/Card";
import { CsvLink } from "@/components/ui/CsvLink";
import { Kpi } from "@/components/ui/Kpi";
import { MandateInfo, hasMandate } from "@/components/customers/MandateInfo";
import { formatCents } from "@/lib/money";
import { PortalLinkCard } from "@/components/customers/PortalLinkCard";
import { loadPortalSettings } from "@/domain/portal/settings";
import { getPortalLinkStatus } from "@/domain/portal/link";
import { listPortalEvents } from "@/domain/portal/access";
import { labelPortalEvents } from "@/domain/portal/event-labels";

export const dynamic = "force-dynamic";

function deDate(d: Date) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(d);
}

/**
 * Kunden-Detailseite (Phase 8b, Task 4, Facts): `/kunden/[id]` ist ab jetzt die
 * Uebersicht (KPIs + Belegtabs), die 8a-Stammdatenformulare wandern nach
 * `/kunden/[id]/bearbeiten`.
 */
export default async function KundeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await getActiveOrg();

  let overview;
  try {
    overview = await customerOverview(org.id, id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }

  const docSettings = await loadDocumentSettings(org.id);
  const currency = docSettings.defaultCurrency;
  const [revenue, behaviour] = await Promise.all([
    monthlyRevenue(org.id, { customerId: id, months: 24, currency }),
    paymentBehaviour(org.id, { customerId: id }),
  ]);

  const [portalSettings, portalStatus, portalEventRows] = await Promise.all([
    loadPortalSettings(org.id),
    getPortalLinkStatus(org.id, id),
    listPortalEvents(org.id, id, { limit: 10 }),
  ]);
  const portalEvents = await labelPortalEvents(org.id, portalEventRows.items);

  const { customer, kpis } = overview;
  const hasVatId = Boolean(customer.vatId?.trim());
  const vatChecks = hasVatId ? await listVatIdChecks(org.id, id, 10) : [];
  const { current, prior } = revenueWithPriorYear(revenue);
  // Puenktlich/verspaetet als Anzahl bezahlter Rechnungen (onTimeShare ist ein Anteil 0..1).
  const onTime = behaviour.onTimeShare === null ? 0 : Math.round(behaviour.onTimeShare * behaviour.paidCount);
  const punctuality: StackedSegment[] =
    behaviour.onTimeShare === null
      ? []
      : [
          { key: "ontime", label: "Pünktlich", value: onTime, valueLabel: String(onTime), color: CHART_COLORS.ledger },
          { key: "late", label: "Verspätet", value: behaviour.paidCount - onTime, valueLabel: String(behaviour.paidCount - onTime), color: CHART_COLORS.due },
        ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Link href="/kunden" className="text-sm text-ink-muted hover:text-ink">
            ← Kunden
          </Link>
          <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight">{customer.name}</h1>
          {customer.customerNumber && <span className="text-sm text-ink-muted">{customer.customerNumber}</span>}
          {customer.isArchived && <StatusBadge status="ARCHIVED" />}
        </div>
        <Link href={`/kunden/${id}/bearbeiten`} className="rounded-md border border-rule-strong bg-sheet px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper">
          Bearbeiten
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <Kpi label="Offener Betrag" value={formatCents(kpis.openCents)} />
        </Card>
        <Card>
          <Kpi label="Davon überfällig" value={formatCents(kpis.overdueCents)} tone={kpis.overdueCents > 0 ? "stamp" : "default"} />
        </Card>
        <Card>
          <Kpi label="Nettoumsatz" value={formatCents(kpis.totalRevenueCents)} />
        </Card>
      </div>

      {resolveBuyerEndpoint(customer) === null && (
        <p className="text-sm text-ink-soft">Für XRechnung E-Mail, Leitweg-ID oder Peppol-ID hinterlegen.</p>
      )}

      {hasVatId && docSettings && (
        <Card title="USt-IdNr. prüfen (VIES)">
          <VatCheckPanel
            customerId={id}
            vatId={customer.vatId ?? ""}
            enabled={docSettings.viesCheckEnabled}
            checks={vatChecks.map((c) => ({
              id: c.id,
              status: c.status,
              errorCode: c.errorCode,
              requestIdentifier: c.requestIdentifier,
              trigger: c.trigger,
              checkedAtLabel: new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(c.checkedAt),
            }))}
          />
        </Card>
      )}

      {hasMandate(customer) && (
        <Card title="SEPA-Lastschriftmandat">
          <MandateInfo customer={customer} />
        </Card>
      )}

      <Card title="Kundenportal">
        <PortalLinkCard
          customerId={id}
          portalEnabled={portalSettings.enabled}
          customerArchived={customer.isArchived}
          link={
            portalStatus
              ? {
                  active: portalStatus.active,
                  createdAt: portalStatus.createdAt.toISOString(),
                  expiresAt: portalStatus.expiresAt.toISOString(),
                  revokedAt: portalStatus.revokedAt?.toISOString() ?? null,
                  lastViewedAt: portalStatus.lastViewedAt?.toISOString() ?? null,
                  viewCount: portalStatus.viewCount,
                }
              : null
          }
          events={portalEvents.map((e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, fileKind: e.fileKind, docNumber: e.docNumber }))}
          defaultRecipient={customer.invoiceEmail?.trim() || customer.email?.trim() || ""}
        />
      </Card>

      <Card title="Zahlungsverhalten">
        <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-8">
          <Kpi
            label="Ø Tage bis zur Zahlung"
            value={behaviour.avgDaysToPay === null ? "—" : `${behaviour.avgDaysToPay} Tage`}
            hint={behaviour.paidCount === 0 ? "keine bezahlten Rechnungen" : `${behaviour.paidCount} bezahlte Rechnung(en)`}
          />
          {punctuality.length > 0 ? (
            <StackedBar title="Pünktlich bezahlt" segments={punctuality} totalLabel={`${Math.round((behaviour.onTimeShare ?? 0) * 100)} %`} />
          ) : (
            <p className="text-sm text-ink-soft">Noch keine Zahlungen, aus denen sich ein Verhalten ableiten lässt.</p>
          )}
        </div>
      </Card>

      <Card title="Umsatz je Monat (netto) mit Vorjahr" action={<CsvLink href={`/api/reports/revenue.csv?months=24&customerId=${encodeURIComponent(id)}&currency=${encodeURIComponent(currency)}`} what="Umsatz dieses Kunden" />}>
        <ResponsiveBarChart
          title="Umsatz je Monat (netto, 12 Monate)"
          data={current}
          compare={prior}
          compareLabel="Vorjahr"
          emptyMessage="Noch keine Umsätze im Zeitraum."
        />
      </Card>

      <CustomerTabs
        tabs={[
          {
            key: "rechnungen",
            label: `Rechnungen (${overview.invoices.length})`,
            content: (
              <DocTable
                caption="Rechnungen"
                emptyText="Keine Rechnungen."
                rows={overview.invoices.map((r) => ({
                  id: r.id,
                  href: `/rechnungen/${r.id}`,
                  title: r.number ?? "Entwurf",
                  date: deDate(r.issueDate),
                  amount: formatCents(r.grossTotalCents),
                  status: r.effectiveStatus,
                }))}
              />
            ),
          },
          {
            key: "angebote",
            label: `Angebote (${overview.quotes.length})`,
            content: (
              <DocTable
                caption="Angebote"
                emptyText="Keine Angebote."
                rows={overview.quotes.map((q) => ({
                  id: q.id,
                  href: `/dokumente/${q.id}`,
                  title: q.number ?? "Entwurf",
                  date: deDate(q.issueDate),
                  amount: formatCents(q.grossTotalCents),
                  status: q.effectiveStatus,
                }))}
              />
            ),
          },
          {
            key: "lieferscheine",
            label: `Lieferscheine (${overview.deliveryNotes.length})`,
            content: (
              <DocTable
                caption="Lieferscheine"
                emptyText="Keine Lieferscheine."
                rows={overview.deliveryNotes.map((n) => ({
                  id: n.id,
                  href: `/lieferscheine/${n.id}`,
                  title: n.number ?? "Entwurf",
                  date: deDate(n.issueDate),
                  amount: null,
                  status: n.status,
                }))}
              />
            ),
          },
          {
            key: "abos",
            label: `Abos (${overview.recurring.length})`,
            content: (
              <DocTable
                caption="Abos"
                emptyText="Keine Abos."
                dateHeader="Nächste Ausführung"
                rows={overview.recurring.map((r) => ({
                  id: r.id,
                  href: `/abos/${r.id}`,
                  title: r.title,
                  date: deDate(r.nextRunDate),
                  amount: null,
                  status: r.status,
                }))}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

interface DocRow {
  id: string;
  href: string;
  title: string;
  date: string;
  amount: string | null;
  status: string;
}

/** Belegliste eines Kunden-Tabs: Tabelle ab `sm`, darunter Karten (DataTable). */
function DocTable({ rows, caption, emptyText, dateHeader = "Datum" }: { rows: DocRow[]; caption: string; emptyText: string; dateHeader?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-sheet px-2 shadow-[var(--shadow-card)] sm:px-3">
      <DataTable
        caption={caption}
        rows={rows}
        rowKey={(r) => r.id}
        empty={{ text: emptyText }}
        columns={[
          {
            key: "title",
            header: "Nummer",
            mobile: "title",
            cell: (r) => (
              <Link href={r.href} className="break-words font-medium text-pen hover:underline">
                {r.title}
              </Link>
            ),
          },
          { key: "date", header: dateHeader, mobile: "meta", cell: (r) => <span className="text-ink-muted">{r.date}</span> },
          { key: "amount", header: "Brutto", mobile: "amount", cell: (r) => r.amount ?? "" },
          { key: "status", header: "Status", mobile: "meta", cell: (r) => <StatusBadge status={r.status} /> },
        ]}
      />
    </div>
  );
}
