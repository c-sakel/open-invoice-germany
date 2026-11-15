/** Dashboard-Karte Kleinunternehmerregelung (§ 19 UStG), statisch gerendert. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SmallBusinessCard, kuPercent } from "@/components/dashboard/SmallBusinessCard";
import { DashboardWidgets } from "@/components/dashboard/DashboardWidgets";
import type { DashboardSummary } from "@/domain/dashboard/summary";
import type { KuThreshold } from "@/domain/reporting/ku";
import { KU_NOTICE } from "@/schemas/small-business";

const sum = (year: number, over: Partial<KuThreshold["current"]> = {}): KuThreshold["current"] => ({
  year, receivedCents: 0, invoicedCents: 0, externalCents: 0, totalReceivedCents: 0, totalInvoicedCents: 0, documentCount: 0, skippedWithoutEur: 0, ...over,
});

function fixture(over: Partial<KuThreshold> = {}): KuThreshold {
  return {
    applies: true,
    year: 2232,
    warnPercent: 80,
    startYear: null,
    currentLimitCents: 10_000_000,
    previousYearLimitCents: 2_500_000,
    level: "WARN",
    reasons: ["APPROACHING_LIMIT"],
    current: sum(2232, { receivedCents: 7_000_000, externalCents: 1_500_000, totalReceivedCents: 8_500_000, invoicedCents: 7_400_000, totalInvoicedCents: 8_900_000, documentCount: 4 }),
    previous: sum(2231, { receivedCents: 1_200_000, totalReceivedCents: 1_200_000 }),
    notice: KU_NOTICE,
    ...over,
  };
}

const SUMMARY: DashboardSummary = {
  openInvoices: { count: 1, cents: 100 },
  dueInvoices: { count: 0, cents: 0 },
  overdueInvoices: { count: 0, cents: 0 },
  dueThisWeek: { count: 0, cents: 0 },
  partiallyPaid: { count: 0, cents: 0 },
  dunningRequired: { count: 0 },
  revenueThisMonthCents: 0,
  aging: [],
  recentDocuments: [],
  openQuotes: { count: 0, cents: 0 },
  otherCurrencyCount: 0,
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/[\u00a0\u202f]/g, " ");

describe("SmallBusinessCard", () => {
  it("zeigt vereinnahmt, berechnet, ausserhalb, Grenze, Prozent, Vorjahr und Hinweis", () => {
    const t = text(renderToStaticMarkup(<SmallBusinessCard ku={fixture()} />));
    expect(t).toContain("Kleinunternehmerregelung (§ 19 UStG)");
    expect(t).toContain("85.000,00 € von 100.000,00 €");
    expect(t).toContain("85 %");
    expect(t).toContain("Warnschwelle erreicht");
    expect(t).toContain("Vereinnahmt 2232 (netto)");
    expect(t).toContain("89.000,00 €");
    expect(t).toContain("15.000,00 €");
    expect(t).toContain("Vorjahr 2231");
    expect(t).toContain("12.000,00 €");
    expect(t).toContain("100.000,00 €");
    expect(t.endsWith(KU_NOTICE)).toBe(true);
  });

  it("nennt die Stufen in Worten", () => {
    const render = (level: KuThreshold["level"]) => text(renderToStaticMarkup(<SmallBusinessCard ku={fixture({ level, reasons: [] })} />));
    expect(render("OK")).toContain("Unter den Grenzen");
    expect(render("NEXT_YEAR_LOST")).toContain("Grenze für das Folgejahr überschritten");
    expect(render("EXCEEDED")).toContain("Grenze überschritten");
  });

  it("Gruendungsjahr: Grenze 25.000 €", () => {
    const ku = fixture({ startYear: 2232, currentLimitCents: 2_500_000, current: sum(2232, { totalReceivedCents: 1_000_000 }) });
    const t = text(renderToStaticMarkup(<SmallBusinessCard ku={ku} />));
    expect(t).toContain("Grenze 2232 (Gründungsjahr)");
    expect(t).toContain("10.000,00 € von 25.000,00 €");
    expect(t).toContain("40 %");
  });

  it("Gruende als Satz mit Paragraf, ohne Handlungsanweisung", () => {
    const ku = fixture({ level: "EXCEEDED", reasons: ["PREVIOUS_OVER_25000", "CURRENT_OVER_LIMIT"] });
    const t = text(renderToStaticMarkup(<SmallBusinessCard ku={ku} />));
    expect(t).toContain("Der Umsatz des Vorjahres lag über 25.000,00 € (§ 19 Abs. 1 S. 1 UStG).");
    expect(t).toContain("liegt über 100.000,00 € (§ 19 Abs. 1 UStG).");
    expect(t.toLowerCase()).not.toMatch(/sollten|müssen|empfehl|wechseln sie|stellen sie/);
  });

  it("applies falsch: keine Karte (Komponente und Dashboard)", () => {
    const ku = fixture({ applies: false });
    expect(renderToStaticMarkup(<SmallBusinessCard ku={ku} />)).toBe("");
    const dash = renderToStaticMarkup(
      <DashboardWidgets
        summary={SUMMARY}
        revenue24={[]}
        cashIn={[]}
        quotes={[]}
        top={[]}
        currency="EUR"
        notices={[]}
        smallBusiness={ku}
      />,
    );
    expect(dash).not.toContain("Kleinunternehmerregelung (§ 19 UStG)");
    const withCard = renderToStaticMarkup(
      <DashboardWidgets
        summary={SUMMARY}
        revenue24={[]}
        cashIn={[]}
        quotes={[]}
        top={[]}
        currency="EUR"
        notices={[]}
        smallBusiness={fixture()}
      />,
    );
    expect(withCard).toContain("Kleinunternehmerregelung (§ 19 UStG)");
  });

  it("Prozent ohne Float-Rechnung, abgerundet", () => {
    expect(kuPercent(2_899_999, 10_000_000)).toBe(28);
    expect(kuPercent(2_900_000, 10_000_000)).toBe(29);
    expect(kuPercent(0, 10_000_000)).toBe(0);
    expect(kuPercent(1, 0)).toBe(0);
  });
});
