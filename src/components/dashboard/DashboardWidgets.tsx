import Link from "next/link";
import type { DashboardSummary } from "@/domain/dashboard/summary";
import type { MonthlyRevenuePoint } from "@/domain/reporting/revenue";
import type { TopCustomer } from "@/domain/reporting/customers";
import type { CashInPoint } from "@/domain/reporting/cash-in";
import type { QuoteOutcomeRow } from "@/domain/reporting/quote-outcome";
import { formatCents } from "@/lib/money";
import { CHART_COLORS } from "@/components/charts/types";
import { StackedBar } from "@/components/charts/StackedBar";
import { Sparkline } from "@/components/charts/Sparkline";
import { Card } from "@/components/ui/Card";
import { CsvLink } from "@/components/ui/CsvLink";
import { Kpi } from "@/components/ui/Kpi";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { BelegStreckeMini } from "@/components/BelegStreckeMini";
import { ResponsiveBarChart } from "@/components/dashboard/ResponsiveBarChart";
import type { OssThreshold } from "@/domain/reporting/oss";
import { OssCard } from "@/components/dashboard/OssCard";
import type { DashboardNotice } from "@/components/dashboard/notices";
import {
  cashInChartData,
  openBandSegments,
  openTotalCents,
  quoteOutcomeSegments,
  revenueWithPriorYear,
  topCustomerChartData,
} from "@/components/dashboard/chart-data";

function deDate(d: Date) {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(d);
}

const DOC_HREF: Record<string, (id: string) => string> = {
  INVOICE: (id) => `/rechnungen/${id}`,
  QUOTE: (id) => `/dokumente/${id}`,
  DELIVERY_NOTE: (id) => `/lieferscheine/${id}`,
};

const NOTICE_TONE: Record<DashboardNotice["tone"], string> = {
  pen: "border-pen/30 bg-pen-wash",
  seal: "border-seal/30 bg-well",
  stamp: "border-stamp/30 bg-well",
};

/**
 * Dashboard (Phase 16f, T6): Hinweise, Hero "Offene Forderungen" mit Geldfluss-Band, Kacheln mit
 * Verlauf, Umsatz mit Vorjahr, Zahlungseingang vs. Rechnungsausgang, Angebotsquote, Top 5 Kunden
 * und letzte Belege. Beträge nur in der Standardwährung `currency`; andere Währungen erscheinen
 * ausschließlich als Hinweis, nie als Mischsumme.
 */
export function DashboardWidgets({
  summary,
  revenue24,
  cashIn,
  quotes,
  top,
  currency,
  notices,
  oss,
}: {
  summary: DashboardSummary;
  revenue24: MonthlyRevenuePoint[];
  cashIn: CashInPoint[];
  quotes: QuoteOutcomeRow[];
  top: TopCustomer[];
  currency: string;
  notices: DashboardNotice[];
  /** Phase 16e: OSS-Schwelle; die Karte erscheint nur bei EU-Privatkunden-Umsätzen oder Warnstufe. */
  oss?: OssThreshold | null;
}) {
  const openTotal = openTotalCents(summary);
  if (summary.recentDocuments.length === 0 && openTotal === 0) {
    return <EmptyState text="Noch keine Belege. Lege die erste Rechnung an." action={{ label: "Neue Rechnung", href: "/rechnungen/neu" }} />;
  }

  const { current, prior } = revenueWithPriorYear(revenue24, currency);
  const cash = cashInChartData(cashIn, currency);
  const quoteRow = quotes.find((q) => q.currency === currency);
  const quoteSegments = quoteOutcomeSegments(quoteRow);
  const quoteTotal = quoteSegments.reduce((sum, s) => sum + s.value, 0);
  const quoteLabel =
    quoteRow?.acceptedPermille == null
      ? `${quoteTotal} Angebote`
      : `Quote ${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(quoteRow.acceptedPermille / 10)} %`;
  const paidThisMonth = cash.paid.at(-1)?.value ?? 0;
  const otherCurrencies = Math.max(summary.otherCurrencyCount, cash.otherCurrencyCount);

  return (
    <div className="space-y-4">
      {notices.length > 0 && (
        <section aria-label="Hinweise" className="grid gap-3 md:grid-cols-2">
          {notices.map((n) => {
            const body = (
              <>
                <div className="text-sm font-semibold text-ink">{n.title}</div>
                <div className="mt-0.5 text-sm text-ink-soft">{n.body}</div>
              </>
            );
            const cls = `block rounded-[var(--radius-card)] border p-4 ${NOTICE_TONE[n.tone]}`;
            return n.href ? (
              <Link key={n.id} href={n.href} className={cls}>
                {body}
              </Link>
            ) : (
              <div key={n.id} className={cls}>
                {body}
              </div>
            );
          })}
        </section>
      )}

      {otherCurrencies > 0 && (
        <p className="text-sm text-ink-soft">
          Beträge in {otherCurrencies} weiteren {otherCurrencies === 1 ? "Währung" : "Währungen"} sind nicht enthalten.
        </p>
      )}

      <Card>
        <Kpi
          size="hero"
          label="Offene Forderungen"
          value={formatCents(openTotal, currency)}
          hint={
            <>
              {summary.openInvoices.count + summary.dueInvoices.count + summary.overdueInvoices.count} offene Rechnungen
              {" · "}
              <Link href="/rechnungen?status=overdue" className="text-stamp hover:underline">
                {summary.overdueInvoices.count} überfällig, {formatCents(summary.overdueInvoices.cents, currency)}
              </Link>
              {" · "}
              <Link href="/mahnwesen" className="hover:underline">
                Mahnung fällig: {summary.dunningRequired.count}
              </Link>
            </>
          }
        />
        <div className="mt-4">
          <StackedBar title="Geldfluss" segments={openBandSegments(summary, currency)} totalLabel={formatCents(openTotal, currency)} />
        </div>
        {summary.overdueInvoices.count > 0 && (
          <p className="mt-3 text-sm">
            <Link href="/rechnungen?status=overdue" className="font-medium text-pen hover:underline">
              Zu den überfälligen Rechnungen
            </Link>
          </p>
        )}
      </Card>

      {oss && (oss.current.documentCount + oss.previous.documentCount + oss.current.skippedWithoutEur + oss.previous.skippedWithoutEur > 0 || oss.level !== "OK") && <OssCard oss={oss} />}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <Kpi label="Umsatz lfd. Monat" value={formatCents(summary.revenueThisMonthCents, currency)}>
            <Sparkline values={current.map((d) => d.value)} label="Umsatz der letzten 12 Monate" />
          </Kpi>
        </Card>
        <Card>
          <Kpi label="Zahlungseingang lfd. Monat" value={formatCents(paidThisMonth, currency)}>
            <Sparkline values={cash.paid.map((d) => d.value)} label="Zahlungseingang der letzten 12 Monate" />
          </Kpi>
        </Card>
        <Link href="/dokumente?status=SENT" className="block">
          <Card className="h-full">
            <Kpi label="Offene Angebote" value={formatCents(summary.openQuotes.cents, currency)} hint={`${summary.openQuotes.count} Angebot(e)`} />
          </Card>
        </Link>
      </div>

      <Card title="Umsatz je Monat (netto) mit Vorjahr" action={<CsvLink href={`/api/reports/revenue.csv?months=24&currency=${encodeURIComponent(currency)}`} what="Umsatz je Monat" />}>
        <ResponsiveBarChart
          title="Umsatz je Monat (netto, 12 Monate)"
          data={current}
          compare={prior}
          compareLabel="Vorjahr"
          seriesLabel="Umsatz"
          hideTitle
          emptyMessage="Noch keine Umsätze im Zeitraum."
        />
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Zahlungseingang und Rechnungsausgang" action={<CsvLink href="/api/reports/cash-in.csv?months=12" what="Zahlungseingang" />}>
          <ResponsiveBarChart
            title="Zahlungseingang je Monat"
            data={cash.paid}
            compare={cash.invoiced}
            compareLabel="Rechnungsausgang"
            seriesLabel="Zahlungseingang"
            hideTitle
            color={CHART_COLORS.ledger}
            emptyMessage="Noch keine Zahlungen im Zeitraum."
          />
        </Card>
        <Card title="Angebotsquote (12 Monate)" action={<CsvLink href="/api/reports/quote-outcome.csv?months=12" what="Angebotsquote" />}>
          {quoteTotal > 0 ? (
            <StackedBar title="Angebote nach Ausgang" segments={quoteSegments} totalLabel={quoteLabel} />
          ) : (
            <p className="py-6 text-center text-sm text-ink-muted">Noch keine Angebote im Zeitraum.</p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top 5 Kunden (netto, 12 Monate)" action={<CsvLink href="/api/reports/top-customers.csv?months=12&limit=5" what="Top 5 Kunden" />}>
          <ResponsiveBarChart
            title="Top 5 Kunden (netto, 12 Monate)"
            data={topCustomerChartData(top)}
            orientation="horizontal"
            hideTitle
            emptyMessage="Noch keine Umsätze im Zeitraum."
          />
        </Card>
        <Card title="Letzte Belege">
          <ul className="divide-y divide-rule">
            {summary.recentDocuments.map((d) => (
              <li key={`${d.kind}-${d.id}`} className="py-2 text-sm sm:flex sm:items-center sm:gap-x-3">
                <div className="flex items-center gap-x-3 sm:contents">
                  <a href={DOC_HREF[d.kind](d.id)} className="font-medium text-pen hover:underline">
                    {d.number ?? "Entwurf"}
                  </a>
                  <span className="shrink-0 text-ink-muted sm:order-3">{deDate(d.date)}</span>
                  <span className="ml-auto flex items-center gap-2 sm:order-4 sm:ml-0">
                    {d.kind === "INVOICE" && <BelegStreckeMini status={d.status} hideText />}
                    <StatusBadge status={d.status} />
                  </span>
                </div>
                <div className="mt-0.5 break-words text-ink-muted sm:order-2 sm:mt-0 sm:min-w-0 sm:flex-1 sm:truncate">{d.customerName}</div>
              </li>
            ))}
            {summary.recentDocuments.length === 0 && <li className="py-6 text-center text-ink-muted">Noch keine Belege.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
