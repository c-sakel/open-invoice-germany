/**
 * Phase 12e, Task 1 — der Inline-SVG-Baukasten. Kein RTL im Projekt: gerendert wird mit
 * renderToStaticMarkup (react-dom/server, Next-Abhaengigkeit) und im HTML-String geprueft.
 * `environment: "node"` genuegt — renderToStaticMarkup braucht kein DOM. `tsconfig.json`
 * hat `"jsx": "react-jsx"`, das esbuild von Vitest uebernimmt die Einstellung; scheitert
 * der Lauf dennoch an JSX, `esbuild: { jsx: "automatic" }` in vitest.config.ts ergaenzen.
 *
 * Fix 1 (Review): Geometrie-Tests fuer negative Balken (`parseRects` prueft jedes <rect>
 * gegen die viewBox-Grenzen), Kontrastfarbe der Achsen-/Wertebeschriftung, und schaerfere
 * Verhaltens-Assertions fuer die Randfaelle "ein Punkt" (LineChart) und "Summe 0" (Donut)
 * statt nur "kein NaN".
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart } from "@/components/charts/BarChart";
import { LineChart } from "@/components/charts/LineChart";
import { DonutChart } from "@/components/charts/DonutChart";
import type { ChartDatum } from "@/components/charts/types";

const DATA: ChartDatum[] = [
  { label: "Jan 26", value: 100000, valueLabel: "1.000,00 €" },
  { label: "Feb 26", value: 250000, valueLabel: "2.500,00 €" },
  { label: "Mär 26", value: 0, valueLabel: "0,00 €" },
];

function expectNoNaN(html: string) {
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("Infinity");
  expect(html).not.toContain("undefined");
}

/** Extrahiert x/y/width/height jedes <rect> aus dem gerenderten HTML-String. */
function parseRects(html: string): { x: number; y: number; width: number; height: number }[] {
  const rects: { x: number; y: number; width: number; height: number }[] = [];
  const rectTagRegex = /<rect\b([^>]*)>/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = rectTagRegex.exec(html))) {
    const attrs = tagMatch[1];
    const get = (name: string) => {
      const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
      return m ? Number(m[1]) : NaN;
    };
    rects.push({ x: get("x"), y: get("y"), width: get("width"), height: get("height") });
  }
  return rects;
}

function expectRectsWithinBounds(html: string, width: number, height: number, minCount = 1) {
  const rects = parseRects(html);
  expect(rects.length).toBeGreaterThanOrEqual(minCount);
  for (const r of rects) {
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(width);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(height);
  }
}

describe("BarChart", () => {
  it("rendert Balken mit <title>, role=img, aria-label, svg-title/desc und sr-only-Wertetabelle", () => {
    const html = renderToStaticMarkup(<BarChart title="Umsatz je Monat" data={DATA} />);
    expect(html.match(/<rect/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("<title>Feb 26: 2.500,00 €</title>");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Umsatz je Monat"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/<title id="[^"]+">Umsatz je Monat<\/title>/);
    expect(html).toMatch(/<desc id="[^"]+">/);
    expect(html).toContain("sr-only");
    expect(html).toContain("<td>Jan 26</td>");
    expectNoNaN(html);
  });

  it("waagerecht kehrt die Geometrie um, nicht die Datenreihenfolge", () => {
    const html = renderToStaticMarkup(<BarChart title="Top 5" data={DATA} orientation="horizontal" />);
    expect(html.indexOf("Jan 26")).toBeLessThan(html.indexOf("Feb 26"));
    expectNoNaN(html);
  });

  it("kommt mit Nullwerten, leeren Daten und negativen Werten zurecht", () => {
    expectNoNaN(renderToStaticMarkup(<BarChart title="Null" data={DATA.map((d) => ({ ...d, value: 0 }))} />));
    const empty = renderToStaticMarkup(<BarChart title="Leer" data={[]} />);
    expect(empty).toContain("Keine Daten");
    expectNoNaN(empty);
    expectNoNaN(renderToStaticMarkup(<BarChart title="Umsatz" data={[...DATA, { label: "Apr 26", value: -50000, valueLabel: "-500,00 €" }]} />));
  });

  it("negative Balken bleiben innerhalb der viewBox (senkrecht, gemischte Vorzeichen)", () => {
    const withNegative = [...DATA, { label: "Apr 26", value: -50000, valueLabel: "-500,00 €" }];
    const html = renderToStaticMarkup(<BarChart title="Umsatz" data={withNegative} />);
    expectRectsWithinBounds(html, 640, 240, 4);
    expectNoNaN(html);
  });

  it("negative Balken bleiben innerhalb der viewBox (waagerecht, gemischte Vorzeichen)", () => {
    const withNegative = [...DATA, { label: "Apr 26", value: -50000, valueLabel: "-500,00 €" }];
    const html = renderToStaticMarkup(<BarChart title="Umsatz" data={withNegative} orientation="horizontal" />);
    expectRectsWithinBounds(html, 640, withNegative.length * 34 + 20, 4);
    expectNoNaN(html);
  });

  it("eine komplett negative Reihe bleibt innerhalb der viewBox (senkrecht und waagerecht)", () => {
    const allNegative: ChartDatum[] = [
      { label: "Jan 26", value: -10000, valueLabel: "-100,00 €" },
      { label: "Feb 26", value: -30000, valueLabel: "-300,00 €" },
      { label: "Mär 26", value: -5000, valueLabel: "-50,00 €" },
    ];
    const vertical = renderToStaticMarkup(<BarChart title="Verlust" data={allNegative} />);
    expectRectsWithinBounds(vertical, 640, 240, 3);
    expectNoNaN(vertical);

    const horizontal = renderToStaticMarkup(<BarChart title="Verlust" data={allNegative} orientation="horizontal" />);
    expectRectsWithinBounds(horizontal, 640, allNegative.length * 34 + 20, 3);
    expectNoNaN(horizontal);
  });

  it("Achsen-/Wertebeschriftung nutzt die AA-Kontrastfarbe slate-600, nicht slate-400", () => {
    const html = renderToStaticMarkup(<BarChart title="Umsatz je Monat" data={DATA} />);
    expect(html).toContain('fill="#475569"');
    expect(html).not.toContain('fill="#94a3b8"');
  });
});

describe("LineChart", () => {
  it("rendert eine Polylinie und je Punkt einen Kreis mit <title>", () => {
    const html = renderToStaticMarkup(<LineChart title="Umsatz je Monat" data={DATA} />);
    expect(html).toContain("<polyline");
    expect(html.match(/<circle/g)?.length).toBe(3);
    expect(html).toContain("<title>Jan 26: 1.000,00 €</title>");
    expectNoNaN(html);
  });
  it("ein einzelner Punkt erzeugt keine kaputte Linie", () => {
    const html = renderToStaticMarkup(<LineChart title="Einer" data={[DATA[0]]} />);
    expect(html).not.toContain("<polyline");
    expect(html.match(/<circle/g)?.length).toBe(1);
    expectNoNaN(html);
  });
});

describe("DonutChart", () => {
  it("rendert je Segment einen Kreis mit <title> und die Summe in der Mitte", () => {
    const html = renderToStaticMarkup(
      <DonutChart
        title="Offen / Überfällig / Bezahlt"
        data={[
          { label: "Offen", value: 3, valueLabel: "3 Rechnungen", color: "#4f46e5" },
          { label: "Überfällig", value: 1, valueLabel: "1 Rechnung", color: "#e11d48" },
          { label: "Bezahlt", value: 6, valueLabel: "6 Rechnungen", color: "#0d9488" },
        ]}
      />,
    );
    expect(html.match(/<circle/g)?.length).toBeGreaterThanOrEqual(4); // Spur + 3 Segmente
    expect(html).toContain("<title>Überfällig: 1 Rechnung</title>");
    expect(html).toContain("10"); // Gesamtzahl in der Mitte
    expect(html).toMatch(/<ul aria-hidden="true"/); // sr-only-Tabelle traegt die Werte bereits vor
    expectNoNaN(html);
  });
  it("Summe 0 erzeugt keine Division durch Null", () => {
    const html = renderToStaticMarkup(<DonutChart title="Leer" data={[{ label: "Offen", value: 0, valueLabel: "0" }]} />);
    expect(html.match(/<circle/g)?.length).toBe(1); // nur die Spur, kein Segment
    expectNoNaN(html);
  });
});
