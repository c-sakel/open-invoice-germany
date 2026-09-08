/**
 * Phase 12e, Task 4 — die Aufbereitung der Diagrammdaten. Reine Funktionen aus den
 * Widget-Modulen (kein DB-Zugriff), danach als SVG gerendert und im String geprueft.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgingChart } from "@/components/dashboard/AgingChart";
import { revenueChartData, statusDonutData, topCustomerChartData } from "@/components/dashboard/chart-data";

describe("AgingChart bleibt kompatibel", () => {
  it("nimmt weiterhin AgingBucket[] und rendert jetzt SVG-Balken", () => {
    const html = renderToStaticMarkup(<AgingChart aging={[{ label: "0–7 Tage", count: 2, cents: 15000 }, { label: "> 90 Tage", count: 0, cents: 0 }]} />);
    expect(html).toContain("<rect");
    expect(html).toContain("0–7 Tage");
    expect(html).not.toContain("NaN");
  });
});

describe("Aufbereitung", () => {
  it("revenueChartData beschriftet Monate deutsch und formatiert Betraege", () => {
    const data = revenueChartData([{ month: "2086-01", netCents: 123456, count: 2 }]);
    expect(data[0].label).toBe("Jan 86");
    expect(data[0].valueLabel).toContain("1.234,56");
    expect(data[0].value).toBe(123456);
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
