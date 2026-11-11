/**
 * Aufbereitung der Diagrammdaten (Phase 12e, Task 4). Reine Funktionen ohne DB-Zugriff —
 * wandeln die Rueckgaben der Reporting-Domain (src/domain/reporting/*) und des
 * bestehenden Dashboard-Summarys (src/domain/dashboard/summary.ts) in `ChartDatum[]` fuer
 * den Baukasten (src/components/charts) um. Getrennt von den Widget-Komponenten, damit sie
 * ohne React-Rendering getestet werden koennen (test/unit/dashboard-charts.test.tsx).
 */
import type { ChartDatum } from "@/components/charts/types";
import { CHART_COLORS } from "@/components/charts/types";
import type { MonthlyRevenuePoint } from "@/domain/reporting/revenue";
import type { TopCustomer } from "@/domain/reporting/customers";
import type { StatusCount } from "@/domain/reporting/status";
import type { AgingBucket, DashboardSummary } from "@/domain/dashboard/summary";
import type { CashInPoint } from "@/domain/reporting/cash-in";
import type { QuoteOutcomeRow } from "@/domain/reporting/quote-outcome";
import type { StackedSegment } from "@/components/charts/StackedBar";
import { formatCents } from "@/lib/money";

/**
 * "2086-01" -> "Jan 86" (de-DE, UTC). `Intl` liefert fuer abgekuerzte Monate einen Punkt
 * ("Jan. 86") — der wird entfernt, damit die Achsenbeschriftung kompakt bleibt (deckt sich
 * mit den Testdaten in test/unit/charts.test.tsx, die bereits ohne Punkt geschrieben sind).
 */
function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("de-DE", { month: "short", year: "2-digit", timeZone: "UTC" })
    .format(d)
    .replace(/\./g, "");
}

/**
 * Umsatzreihe (`monthlyRevenue`) als Balken — negative Monate (Gutschrift-Ueberhang) bleiben
 * negativ.
 *
 * Fix M1 (Abschluss-Review): `monthlyRevenue` fuellt IMMER alle Monats-Buckets (auch ohne
 * Beleg als 0-Eintrag, siehe dortiger Modulkommentar) — `ChartFrame`s Leerzustand
 * (`data.length === 0`) trat dadurch nie ein; ein frisch angelegter Kunde/eine frische Org
 * bekam stattdessen eine nichtssagende Nulllinie direkt auf der unteren Kante. Liefert jetzt
 * `[]`, wenn KEIN Bucket einen Beleg traegt (`count === 0`), damit `BarChart`/`LineChart`
 * ueber ihr `emptyMessage`-Prop den Leerzustand zeigen statt der Nulllinie.
 */
export function revenueChartData(points: MonthlyRevenuePoint[]): ChartDatum[] {
  if (points.every((p) => p.count === 0)) return [];
  return points.map((p) => ({
    label: monthLabel(p.month),
    value: p.netCents,
    valueLabel: formatCents(p.netCents),
  }));
}

type StatusDonutSegment = { label: string; color: string; statuses: StatusCount["status"][] };

/** Drei feste Segmente fuers Ringdiagramm — PARTIALLY_PAID zaehlt zu "Offen", nicht zu "Bezahlt". */
const STATUS_DONUT_SEGMENTS: StatusDonutSegment[] = [
  { label: "Offen", color: CHART_COLORS.primary, statuses: ["OPEN", "DUE", "PARTIALLY_PAID"] },
  { label: "Überfällig", color: CHART_COLORS.overdue, statuses: ["OVERDUE"] },
  { label: "Bezahlt", color: CHART_COLORS.second, statuses: ["PAID"] },
];

/**
 * Buendelt `statusCounts` zu Offen/Ueberfaellig/Bezahlt. Segmente mit `value === 0` bleiben
 * in der Liste (Legende vollstaendig), der Donut selbst ignoriert sie geometrisch.
 */
export function statusDonutData(rows: StatusCount[]): ChartDatum[] {
  return STATUS_DONUT_SEGMENTS.map((segment) => {
    const count = rows.filter((r) => segment.statuses.includes(r.status)).reduce((sum, r) => sum + r.count, 0);
    return {
      label: segment.label,
      value: count,
      valueLabel: `${count} Rechnung${count === 1 ? "" : "en"}`,
      color: segment.color,
    };
  });
}

/** Kuerzt einen Kundennamen auf `max` Zeichen (inkl. Ellipse) fuer die Diagrammachse. */
function truncateName(name: string, max = 24): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** `topCustomers` als waagerechte Balken — Reihenfolge (nach Umsatz sortiert) bleibt erhalten. */
export function topCustomerChartData(rows: TopCustomer[]): ChartDatum[] {
  return rows.map((r) => ({
    label: truncateName(r.name),
    value: r.netCents,
    valueLabel: formatCents(r.netCents),
  }));
}

/** Aging-Buckets (src/domain/dashboard/summary.ts) als waagerechte Balken. */
export function agingChartData(buckets: AgingBucket[]): ChartDatum[] {
  return buckets.map((b) => ({
    label: b.label,
    value: b.cents,
    valueLabel: `${formatCents(b.cents)} (${b.count})`,
    color: CHART_COLORS.due,
  }));
}

/** Farben der fuenf Alters-Buckets: pen -> seal -> seal -> stamp -> stamp. */
const AGING_COLORS = [CHART_COLORS.primary, CHART_COLORS.due, CHART_COLORS.due, CHART_COLORS.overdue, CHART_COLORS.overdue];

/** Gesamtbetrag der offenen Forderungen (offen + heute faellig + ueberfaellig). */
export function openTotalCents(summary: DashboardSummary): number {
  return summary.openInvoices.cents + summary.dueInvoices.cents + summary.overdueInvoices.cents;
}

/** Geldfluss-Band: "Noch nicht faellig" (gruen) plus die Alters-Buckets der faelligen Posten. */
export function openBandSegments(summary: DashboardSummary, currency = "EUR"): StackedSegment[] {
  return [
    {
      key: "not-due",
      label: "Noch nicht fällig",
      value: summary.openInvoices.cents,
      valueLabel: formatCents(summary.openInvoices.cents, currency),
      color: CHART_COLORS.ledger,
    },
    ...summary.aging.map((b, i) => ({
      key: `aging-${i}`,
      label: b.label,
      value: b.cents,
      valueLabel: formatCents(b.cents, currency),
      color: AGING_COLORS[i] ?? CHART_COLORS.overdue,
    })),
  ];
}

/** 24 Monate -> letzte 12 = aktuell, erste 12 = Vorjahr (Label = Label des aktuellen Monats). */
export function revenueWithPriorYear(
  points24: MonthlyRevenuePoint[],
  currency = "EUR",
): { current: ChartDatum[]; prior: ChartDatum[] } {
  if (points24.every((p) => p.count === 0 && p.netCents === 0)) return { current: [], prior: [] };
  const currentPoints = points24.slice(-12);
  const priorPoints = points24.slice(-24, -12);
  const toDatum = (p: MonthlyRevenuePoint, label: string): ChartDatum => ({
    label,
    value: p.netCents,
    valueLabel: formatCents(p.netCents, currency),
  });
  const current = currentPoints.map((p) => toDatum(p, monthLabel(p.month)));
  const prior = priorPoints.map((p, i) => toDatum(p, current[i]?.label ?? monthLabel(p.month)));
  return { current, prior };
}

/** Zahlungseingang (paid) und Rechnungsausgang brutto (invoiced) der Standardwaehrung; andere Waehrungen werden nur gezaehlt. */
export function cashInChartData(
  points: CashInPoint[],
  currency: string,
): { paid: ChartDatum[]; invoiced: ChartDatum[]; otherCurrencyCount: number } {
  const own = points.filter((p) => p.currency === currency);
  const otherCurrencyCount = points.length - own.length;
  const paid = own.map((p) => ({ label: monthLabel(p.month), value: p.paidCents, valueLabel: formatCents(p.paidCents, currency) }));
  const invoiced = own.map((p) => ({
    label: monthLabel(p.month),
    value: p.invoicedGrossCents,
    valueLabel: formatCents(p.invoicedGrossCents, currency),
  }));
  if (own.every((p) => p.paidCents === 0 && p.invoicedGrossCents === 0)) return { paid: [], invoiced: [], otherCurrencyCount };
  return { paid, invoiced, otherCurrencyCount };
}

/** Angebotsausgang als Anteile nach Anzahl (angenommen/abgelehnt/abgelaufen/offen). */
export function quoteOutcomeSegments(row: QuoteOutcomeRow | undefined): StackedSegment[] {
  if (!row) return [];
  const seg = (key: string, label: string, bucket: QuoteOutcomeRow["open"], color: string): StackedSegment => ({
    key,
    label,
    value: bucket.count,
    valueLabel: `${bucket.count} (${formatCents(bucket.netCents, row.currency)})`,
    color,
  });
  return [
    seg("accepted", "Angenommen", row.accepted, CHART_COLORS.ledger),
    seg("rejected", "Abgelehnt", row.rejected, CHART_COLORS.overdue),
    seg("expired", "Abgelaufen", row.expired, CHART_COLORS.due),
    seg("open", "Offen", row.open, CHART_COLORS.primary),
  ];
}
