/**
 * Phase 12e, Task 4 — die Aufbereitung der Diagrammdaten. Reine Funktionen aus den
 * Widget-Modulen (kein DB-Zugriff), danach als SVG gerendert und im String geprueft.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardWidgets } from "@/components/dashboard/DashboardWidgets";
import type { DashboardSummary } from "@/domain/dashboard/summary";
import type { MonthlyRevenuePoint } from "@/domain/reporting/revenue";
import {
  cashInChartData,
  openBandSegments,
  openTotalCents,
  revenueChartData,
  revenueWithPriorYear,
  statusDonutData,
  topCustomerChartData,
} from "@/components/dashboard/chart-data";

function summaryFixture(over: Partial<DashboardSummary> = {}): DashboardSummary {
  const zero = { count: 0, cents: 0 };
  return {
    openInvoices: { count: 1, cents: 10000 },
    dueInvoices: { count: 1, cents: 2000 },
    overdueInvoices: { count: 1, cents: 5000 },
    dueThisWeek: zero,
    partiallyPaid: zero,
    dunningRequired: { count: 0 },
    revenueThisMonthCents: 0,
    aging: [
      { label: "0–7 Tage", count: 1, cents: 2000 },
      { label: "8–30 Tage", count: 0, cents: 0 },
      { label: "31–60 Tage", count: 1, cents: 5000 },
      { label: "61–90 Tage", count: 0, cents: 0 },
      { label: "> 90 Tage", count: 0, cents: 0 },
    ],
    recentDocuments: [{ kind: "INVOICE", id: "i1", number: "RE-1", customerName: "Kunde", date: new Date("2026-01-01T00:00:00Z"), grossCents: 100, status: "SENT" }],
    openQuotes: zero,
    otherCurrencyCount: 0,
    ...over,
  };
}

function renderDashboard(summary: DashboardSummary, notices: { id: string; tone: "pen"; title: string; body: string }[] = []) {
  return renderToStaticMarkup(
    <DashboardWidgets summary={summary} revenue24={[]} cashIn={[]} quotes={[]} top={[]} currency="EUR" notices={notices} />,
  );
}

describe("Dashboard Geldfluss und Vergleichsreihen", () => {
  it("Band-Segmente ergeben den offenen Gesamtbetrag", () => {
    const summary = summaryFixture();
    const segments = openBandSegments(summary);
    expect(segments[0]).toMatchObject({ key: "not-due", label: "Noch nicht fällig", value: 10000, color: "var(--color-pen)" });
    expect(segments).toHaveLength(6);
    expect(segments.reduce((sum, s) => sum + s.value, 0)).toBe(openTotalCents(summary));
    expect(openTotalCents(summary)).toBe(17000);
  });

  it("Vorjahresreihe um 12 Monate verschoben", () => {
    const points: MonthlyRevenuePoint[] = Array.from({ length: 24 }, (_, i) => ({
      month: `${i < 12 ? 2025 : 2026}-${String((i % 12) + 1).padStart(2, "0")}`,
      netCents: (i + 1) * 100,
      count: 1,
    }));
    const { current, prior } = revenueWithPriorYear(points);
    expect(prior[0].value).toBe(100);
    expect(current[0].value).toBe(1300);
    expect(prior[0].label).toBe(current[0].label);
    expect(current).toHaveLength(12);
    expect(prior).toHaveLength(12);
  });

  it("cashIn filtert Standardwährung und zählt weitere Währungen (distinct)", () => {
    const r = cashInChartData(
      [
        { month: "2026-01", currency: "EUR", paidCents: 500, invoicedGrossCents: 900 },
        { month: "2026-01", currency: "USD", paidCents: 700, invoicedGrossCents: 700 },
        { month: "2026-02", currency: "USD", paidCents: 100, invoicedGrossCents: 100 },
      ],
      "EUR",
    );
    expect(r.paid.map((d) => d.value)).toEqual([500]);
    expect(r.invoiced.map((d) => d.value)).toEqual([900]);
    expect(r.otherCurrencyCount).toBe(1);
  });
});

describe("DashboardWidgets", () => {
  it("Leerzustand ohne Belege: EmptyState mit Link /rechnungen/neu, kein <svg>", () => {
    const html = renderDashboard(
      summaryFixture({ openInvoices: { count: 0, cents: 0 }, dueInvoices: { count: 0, cents: 0 }, overdueInvoices: { count: 0, cents: 0 }, recentDocuments: [] }),
    );
    expect(html).toContain('href="/rechnungen/neu"');
    expect(html).not.toContain("<svg");
  });

  it("Hinweise-Bereich nur mit notices", () => {
    expect(renderDashboard(summaryFixture())).not.toContain('aria-label="Hinweise"');
    const html = renderDashboard(summaryFixture(), [{ id: "oss", tone: "pen", title: "OSS-Schwelle", body: "Text" }]);
    expect(html).toContain('aria-label="Hinweise"');
    expect(html).toContain("OSS-Schwelle");
  });

  it("kein doppeltes Rendering hidden sm:block", () => {
    expect(renderDashboard(summaryFixture())).not.toContain("hidden sm:block");
  });
});

describe("Aufbereitung", () => {
  it("revenueChartData beschriftet Monate deutsch und formatiert Betraege", () => {
    const data = revenueChartData([{ month: "2086-01", netCents: 123456, count: 2 }]);
    expect(data[0].label).toBe("Jan 86");
    expect(data[0].valueLabel).toContain("1.234,56");
    expect(data[0].value).toBe(123456);
  });

  it("Fix M1: revenueChartData liefert [] wenn KEIN Monat einen Beleg traegt (Leerzustand statt Nulllinie)", () => {
    const empty = revenueChartData([
      { month: "2086-01", netCents: 0, count: 0 },
      { month: "2086-02", netCents: 0, count: 0 },
    ]);
    expect(empty).toEqual([]);
  });

  it("Fix M1: ein einzelner Monat mit netCents 0 aber count > 0 (z. B. Storno gleicht Original aus) bleibt KEIN Leerzustand", () => {
    const data = revenueChartData([
      { month: "2086-01", netCents: 0, count: 2 },
      { month: "2086-02", netCents: 0, count: 0 },
    ]);
    expect(data).toHaveLength(2);
  });
  it("statusDonutData buendelt Offen/Ueberfaellig/Bezahlt mit festen Farben", () => {
    const data = statusDonutData([
      { status: "OPEN", label: "Offen", count: 3, openCents: 1000 },
      { status: "DUE", label: "Fällig heute", count: 1, openCents: 500 },
      { status: "OVERDUE", label: "Überfällig", count: 2, openCents: 900 },
      { status: "PAID", label: "Bezahlt", count: 5, openCents: 0 },
    ]);
    expect(data.map((d) => d.label)).toEqual(["Offen", "Überfällig", "Bezahlt"]);
    expect(data[0].value).toBe(4); // OPEN + DUE
    expect(data[1].color).toBeTruthy();
  });
  it("topCustomerChartData kuerzt lange Kundennamen fuer die Achse", () => {
    const data = topCustomerChartData([{ customerId: "c1", name: "Ein sehr langer Kundenname GmbH & Co. KG", netCents: 100, invoiceCount: 1 }]);
    expect(data[0].label.length).toBeLessThanOrEqual(24);
    expect(data[0].valueLabel).toContain("€");
  });
});
