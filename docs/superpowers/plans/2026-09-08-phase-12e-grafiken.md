# Phase 12e — Grafiken auf Übersicht und Kundenseite

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Betreiberwunsch aus dem Phase-12-Auftrag: „Auf der Übersicht schöne Graphen, genauso auf der Kundenübersicht. Soll richtig modern wirken." Dashboard und Kunden-Detailseite bekommen echte Diagramme — Umsatz je Monat über zwölf Monate, Offen/Überfällig/Bezahlt, Top-5-Kunden, Fälligkeitsalter — auf Basis reiner Aggregationsfunktionen. **Keine neue Abhängigkeit**: der Chart-Baukasten ist Inline-SVG im Repository.

**Architecture:** Drei Schichten. (1) `src/domain/reporting/*` — reine, org-gescopte Funktionen über `select`-reduzierte Prisma-Zeilen mit Aggregation in JS (wie `dashboard/summary.ts`, wegen SQLite/Postgres-Portabilität); jede einzeln unit-testbar, jede mit injizierbarem `now`. (2) `src/components/charts/*` — vier Server-Komponenten ohne `"use client"` (Dashboard und Kundenseite sind Server-Komponenten), reines `<svg viewBox>`, Tooltips über natives `<title>`, `role="img"` + `aria-label` + visuell versteckte Wertetabelle. Die Komponenten nehmen **fertig formatierte** Datenpunkte entgegen (`{ label, value, valueLabel }`) — keine Funktions-Props, damit sie ohne Serialisierungsfragen überall verwendbar und im String testbar sind. (3) Die beiden Seiten verdrahten beides; `dashboardSummary` und `customerOverview` werden **nicht** dupliziert.

**Tech Stack:** Next.js App Router (Server-Komponenten), Tailwind v4, Prisma, Vitest (`environment: "node"`, **kein RTL**; Komponenten werden mit `renderToStaticMarkup` aus `react-dom/server` als HTML-String geprüft), Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-08-phase-12-feinschliff-design.md` — Paket **F** (Abschnitt 2: „Chart-Baukasten", „Auswertungen", „Dashboard", „Kundenübersicht", „Auswertungen als Schnittstelle"), Struktur Abschnitt 3 Block F, Tests Abschnitt 4 F, Teilphase 5 in Abschnitt 5.

## Global Constraints

- Branch `phase-12e/grafiken` aus Fork-`main` (nach dem Merge von 12d). Jeder Commit mit `git commit -s`.
- **Keine neue Abhängigkeit** — keine Chart-Bibliothek, kein `d3`, kein `recharts`. `package.json` bleibt unverändert.
- **Keine Migration.** Phase 12e ist rein additiv und lesend; die Tabellenzahl bleibt bei 45 (nach 12d). `scripts/test-postgres-migrations.sh` wird nicht angefasst.
- **Geld (§50):** ausschließlich Integer-Cent; jede Anzeige über `formatCents` (`src/lib/money.ts:18`), jede Rundung über `roundHalfUp` (`src/lib/money.ts:13`). Keine Floats in den Aggregaten — Anteile (`onTimeShare`) sind der einzige Bruch und werden als `number` 0..1 geführt, nie als Geldbetrag.
- **Zeitzonen:** alle Monats-/Tagesgrenzen in **UTC** über `utcDateOnly` (`src/lib/date-only.ts`) bzw. `Date.UTC` — dieselbe Konvention wie `dashboard/summary.ts` (`startOfMonth`/`startOfNextMonth`). Jeder Test läuft zusätzlich mit `TZ=UTC`.
- **Nichts doppelt bauen (§1.4):** `dashboardSummary` bleibt die Quelle für Offen/Fällig/Überfällig/Umsatz-Monat/Aging/Angebote; `customerOverview` bleibt die Quelle für `openCents`/`overdueCents`/`totalRevenueCents`. `AgingChart.tsx` behält Datei **und** Exportnamen und rendert intern den neuen horizontalen `BarChart`. `effectiveInvoiceStatus`, `payableBaseCents`, `formatCents`, `CustomerTabs` werden benutzt, nicht nachgebaut.
- **Zod an der Grenze (§50):** die Report-Query wird mit `reportQuerySchema` validiert (REST **und** MCP nutzen dasselbe Schema).
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen. Deutsche UI-Texte mit echten Umlauten.
- **Barrierefreiheit:** jedes Diagramm trägt `role="img"` und ein `aria-label`; unter dem SVG steht eine `sr-only`-Tabelle mit denselben Werten (ein Screenreader liest nie nur „Grafik").
- Prüfkette vor jedem Commit **im Vordergrund**: `npm run typecheck && npm run lint && TZ=UTC npm test`. Vor dem letzten Commit zusätzlich `npm run build`, `npm run validate:erechnung`, `npm run api:check`. Alle Bestandstests bleiben grün (§1.7).

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/components/charts/types.ts` | `ChartDatum`, `ChartSeries`, Palette |
| `src/components/charts/ChartFrame.tsx` | Rahmen: Titel, `role="img"`, `aria-label`, `sr-only`-Wertetabelle, `viewBox` |
| `src/components/charts/BarChart.tsx` | Balken senkrecht **und** waagerecht (ein Bauteil, `orientation`) |
| `src/components/charts/LineChart.tsx` | Zeitreihe: Polylinie + Punkte mit `<title>` |
| `src/components/charts/DonutChart.tsx` | Ring über `stroke-dasharray` (keine Bogen-Mathematik ⇒ keine `NaN`) |
| `src/domain/reporting/revenue.ts` | `monthlyRevenue` |
| `src/domain/reporting/customers.ts` | `topCustomers` |
| `src/domain/reporting/status.ts` | `statusCounts` |
| `src/domain/reporting/payment-behaviour.ts` | `paymentBehaviour` |
| `src/domain/reporting/query.ts` | `reportQuerySchema`, `runReport` (gemeinsamer Kern für REST + MCP) |
| `src/app/page.tsx`, `src/components/dashboard/DashboardWidgets.tsx` | Diagramme unter den Kacheln |
| `src/components/dashboard/AgingChart.tsx` | rendert intern `BarChart` (Datei/Export bleiben) |
| `src/app/kunden/[id]/page.tsx` | zwei KPI-Kacheln + Zeitreihe über den Reitern |
| `src/app/api/v1/Report/route.ts` | lesende Ressource (Scope `read`) |
| `src/mcp/tools/system.ts` | `get_report` |
| `openapi/openapi.json` | regeneriert |
| `docs/{ANLEITUNG,ARCHITEKTUR,LIMITATIONEN,API,MCP}.md` | Doku |

---

### Task 1: Chart-Baukasten (Inline-SVG, keine Abhängigkeit)

**Files:**
- Create: `src/components/charts/types.ts`, `src/components/charts/ChartFrame.tsx`, `src/components/charts/BarChart.tsx`, `src/components/charts/LineChart.tsx`, `src/components/charts/DonutChart.tsx`, `test/unit/charts.test.tsx`

**Befund (verifiziert):** Es gibt heute keine Chart-Ebene — `AgingChart.tsx` sind reine CSS-`div`-Balken (`bg-amber-500`, Breite über `style.width`), ohne SVG und ohne Tooltip. `package.json` enthält keine Chart-Bibliothek. Es gibt **keine** CSS-Design-Tokens; die Codebasis nutzt Ad-hoc-Tailwind-Klassen (indigo-600 primär, slate-* neutral, amber-500 Warnung, rose-700 Gefahr) — die Palette wird deshalb als Hex-Konstanten in `types.ts` festgehalten, passend zu diesen Klassen.

**Ruling (Ergänzung zur Spec):** Die Spec listet `LineChart` im Baukasten, ordnet aber beiden Seiten `BarChart` zu — eine Komponente ohne Konsument wäre eine Attrappe (§59). **`LineChart` wird auf der Kunden-Detailseite für „Umsatz je Monat (12 Monate)" verwendet**, das Dashboard behält den `BarChart`. Das trennt die beiden Ansichten zusätzlich optisch und ist der kanonische Fall für eine Linie (dichte, lückenlose Zeitreihe).

**Interfaces:**
```ts
// src/components/charts/types.ts
export interface ChartDatum {
  label: string;        // Achsen-/Legendenbeschriftung, z. B. "Mär 26"
  value: number;        // Rohwert (Cent oder Anzahl) — nur fuer die Geometrie
  valueLabel: string;   // fertig formatiert, z. B. "1.234,56 €" — fuer <title> und sr-only
  color?: string;       // Ueberschreibt die Reihenfarbe (Donut/Status)
}
export const CHART_COLORS = {
  primary: "#4f46e5",   // indigo-600
  second: "#0d9488",    // teal-600
  due: "#f59e0b",       // amber-500
  overdue: "#e11d48",   // rose-600
  grid: "#e2e8f0",      // slate-200
  axis: "#94a3b8",      // slate-400
} as const;

// ChartFrame
interface ChartFrameProps { title: string; ariaLabel: string; data: ChartDatum[]; width: number; height: number; children: ReactNode }

// BarChart / LineChart / DonutChart
interface BarChartProps { title: string; data: ChartDatum[]; orientation?: "vertical" | "horizontal"; color?: string }
interface LineChartProps { title: string; data: ChartDatum[]; color?: string }
interface DonutChartProps { title: string; data: ChartDatum[] }   // Farbe je Datum ueber datum.color
```

- [ ] **Step 1: Failing test schreiben**

```tsx
// test/unit/charts.test.tsx
/**
 * Phase 12e, Task 1 — der Inline-SVG-Baukasten. Kein RTL im Projekt: gerendert wird mit
 * renderToStaticMarkup (react-dom/server, Next-Abhaengigkeit) und im HTML-String geprueft.
 * `environment: "node"` genuegt — renderToStaticMarkup braucht kein DOM. `tsconfig.json`
 * hat `"jsx": "react-jsx"`, das esbuild von Vitest uebernimmt die Einstellung; scheitert
 * der Lauf dennoch an JSX, `esbuild: { jsx: "automatic" }` in vitest.config.ts ergaenzen.
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

describe("BarChart", () => {
  it("rendert Balken mit <title>, role=img, aria-label und sr-only-Wertetabelle", () => {
    const html = renderToStaticMarkup(<BarChart title="Umsatz je Monat" data={DATA} />);
    expect(html.match(/<rect/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("<title>Feb 26: 2.500,00 €</title>");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Umsatz je Monat"');
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
    expectNoNaN(renderToStaticMarkup(<LineChart title="Einer" data={[DATA[0]]} />));
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
    expectNoNaN(html);
  });
  it("Summe 0 erzeugt keine Division durch Null", () => {
    const html = renderToStaticMarkup(<DonutChart title="Leer" data={[{ label: "Offen", value: 0, valueLabel: "0" }]} />);
    expectNoNaN(html);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/charts.test.tsx`.

- [ ] **Step 3: `types.ts` und `ChartFrame`**

```tsx
// src/components/charts/ChartFrame.tsx
import type { ReactNode } from "react";
import type { ChartDatum } from "./types";

/**
 * Gemeinsamer Rahmen aller Diagramme (Phase 12e): Ueberschrift, responsives SVG
 * (`viewBox` + `preserveAspectRatio`, Breite 100 %) und eine visuell versteckte
 * Wertetabelle. Letztere ist kein Beiwerk: ein `<svg role="img">` liefert einem
 * Screenreader nur das aria-label — die Zahlen selbst stehen in der Tabelle (WCAG 1.1.1).
 * Server-Komponente: kein "use client", weil Dashboard und Kundenseite Server-Komponenten
 * sind und die Diagramme keinerlei Interaktion brauchen (Tooltip = natives <title>).
 */
export function ChartFrame({ title, ariaLabel, data, width, height, children }: {
  title: string;
  ariaLabel: string;
  data: ChartDatum[];
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-sm font-semibold text-slate-800">{title}</figcaption>
      {data.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">Keine Daten im gewählten Zeitraum.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={ariaLabel} className="h-auto w-full">
            {children}
          </svg>
          <table className="sr-only">
            <caption>{title}</caption>
            <tbody>
              {data.map((d) => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td>{d.valueLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}
```
> **Befund:** `grep -rn "sr-only" src/` ist heute leer — die Klasse wird im Projekt zum ersten Mal benutzt. `sr-only` ist eine Standard-Utility von Tailwind v4 und mit `@import "tailwindcss"` (`src/app/globals.css:1`) verfügbar; das ist im Browser **einmal zu verifizieren** (Element-Inspektor: `position: absolute; clip-path: inset(50%)`). Falls nicht vorhanden, eine eigene `.sr-only`-Regel in `src/app/globals.css` ergänzen — dann in `@layer utilities`, **nicht** in `@layer base` (dort liegt seit 12a die `dialog:modal`-Regel; die Layer-Wahl ist dort begründet).

- [ ] **Step 4: `BarChart`, `LineChart`, `DonutChart`**
  - **`BarChart`** (~90 Zeilen): feste `viewBox` 640×240 (senkrecht) bzw. 640×`data.length * 34 + 20` (waagerecht). `const max = Math.max(1, ...data.map((d) => Math.abs(d.value)))` — die `1` verhindert die Division durch Null bei lauter Nullwerten. Senkrecht: `<rect>` je Datum mit `x = i * step + pad`, `height = (Math.abs(d.value) / max) * plotHeight`, Grundlinie unten (negative Werte wachsen nach unten, siehe Testfall). Waagerecht: Beschriftung links (`<text>`, `text-anchor="end"`), Balken nach rechts, Wert rechts daneben. Jedes `<rect>` enthält `<title>{`${d.label}: ${d.valueLabel}`}</title>` und `className="transition-opacity hover:opacity-80"`. Farbe: `d.color ?? color ?? CHART_COLORS.primary`. Rasterlinien in `CHART_COLORS.grid`.
  - **`LineChart`** (~80 Zeilen): `viewBox` 640×240, Punkte auf `x = pad + (i / Math.max(1, data.length - 1)) * plotWidth`, `y` aus `max` wie oben; eine `<polyline fill="none" stroke={color}>` plus je Punkt ein `<circle r={3}>` mit `<title>`. Bei genau einem Punkt entfällt die Polylinie (nur der Kreis) — der Testfall deckt das ab. X-Beschriftung nur jedes zweite Datum, damit zwölf Monate lesbar bleiben.
  - **`DonutChart`** (~70 Zeilen): `viewBox` 240×240, ein Spur-`<circle>` in `CHART_COLORS.grid` und je Segment ein `<circle>` mit `strokeDasharray={`${len} ${circumference - len}`}` und `strokeDashoffset` als laufende Summe, `transform="rotate(-90 120 120)"`. `const total = data.reduce((s, d) => s + Math.max(0, d.value), 0)`; bei `total === 0` werden nur Spur und Mitteltext gerendert (kein Segment, keine Division). In der Mitte `<text>` mit der Gesamtzahl. Legende als `<ul>` unter dem SVG (nicht im SVG — leichter zu setzen).

- [ ] **Step 5: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/components/charts test/unit/charts.test.tsx
git commit -s -m "feat(charts): Inline-SVG-Baukasten Bar/Line/Donut ohne neue Abhaengigkeit (Phase 12e, Task 1)"
```

---

### Task 2: Auswertungen — Umsatz je Monat und Top-Kunden

**Files:**
- Create: `src/domain/reporting/revenue.ts`, `src/domain/reporting/customers.ts`, `test/integration/reporting-revenue.test.ts`

**Befund (verifiziert):** `Invoice` trägt `netTotalCents`, `taxTotalCents`, `grossTotalCents` und `payableCents Int?`; `payableBaseCents(inv) = payableCents ?? grossTotalCents` (`src/domain/invoice/amounts.ts:17`) ist die vom Projekt bereits benutzte Bemessungsgrundlage — `dashboardSummary` rechnet aus genau diesem Grund **nicht** mit `grossTotalCents` (eine Abschlagskette würde den Abschlag sonst doppelt zählen, Fix-Welle S2). `InvoiceType` kennt sechs Werte (`INVOICE, CREDIT_NOTE, CORRECTION, PARTIAL, DOWNPAYMENT, FINAL`). `roundHalfUp` und `formatCents` liegen in `src/lib/money.ts`.

**Ruling (Netto bei Abschlagsketten):** Die Spec nennt „Basis `netTotalCents`". Ein roher `netTotalCents` würde bei einer Abschlagskette denselben Doppelzähl-Fehler erzeugen, den die Fix-Welle S2 für Brutto behoben hat. Deshalb: **`netShareCents(inv)`** — ohne `payableCents` schlicht `netTotalCents`, mit `payableCents` proportional `roundHalfUp(netTotalCents * payableCents / grossTotalCents)`. Damit summiert eine Abschlags- plus Schlussrechnung genau den Netto-Auftragswert. Die Regel gehört als Kommentar in den Code und in `docs/ARCHITEKTUR.md`.

**Interfaces:**
```ts
// src/domain/reporting/revenue.ts
export interface MonthlyRevenuePoint { month: string; netCents: number; count: number }   // month = "YYYY-MM" (UTC)
export interface MonthlyRevenueOptions { months?: number; customerId?: string; now?: Date }
export function netShareCents(inv: { netTotalCents: number; grossTotalCents: number; payableCents: number | null }): number;
export function monthKey(d: Date): string;
export async function monthlyRevenue(orgId: string, opts?: MonthlyRevenueOptions): Promise<MonthlyRevenuePoint[]>;

// src/domain/reporting/customers.ts
export interface TopCustomer { customerId: string; name: string; netCents: number; invoiceCount: number }
export async function topCustomers(orgId: string, opts?: { months?: number; limit?: number; now?: Date }): Promise<TopCustomer[]>;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/reporting-revenue.test.ts
/**
 * Phase 12e, Task 2 — monthlyRevenue und topCustomers. Eigenes Jahr 2085
 * (Testjahr-Konvention) und eigener Nummernkreis-Praefix (es wird festgeschrieben).
 * Alle Monatsgrenzen in UTC — der Testlauf muss auch mit `TZ=UTC npm test` gruen sein.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { monthlyRevenue, netShareCents, monthKey } from "@/domain/reporting/revenue";
import { topCustomers } from "@/domain/reporting/customers";
import type { CreateInvoiceInput } from "@/schemas";

const NOW = new Date(Date.UTC(2085, 5, 15, 10, 0, 0));     // Juni 2085
const APRIL = new Date(Date.UTC(2085, 3, 10, 10, 0, 0));
const MAY = new Date(Date.UTC(2085, 4, 20, 10, 0, 0));

let orgId: string;
let customerA: string;
let customerB: string;

function line(netCents: number) {
  return { description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
}

async function invoice(customerId: string, netCents: number, issueDate: Date, type: "INVOICE" | "CREDIT_NOTE" = "INVOICE", finalize = true) {
  const inv = await createDraftInvoice(
    orgId,
    { customerId, type, taxScheme: "REGULAR", currency: "EUR", issueDate, lines: [line(netCents)] } as CreateInvoiceInput,
    { now: issueDate },
  );
  if (finalize) await finalizeInvoice(inv.id, { now: issueDate });
  return inv;
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Report Test GmbH", addressLine1: "Reportweg 1", postalCode: "10115", city: "Berlin", vatId: "DE855555555", taxNumber: "85/555/55555" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerA = (await dbInternal.customer.create({ data: { orgId, name: "Alpha AG", addressLine1: "A 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } })).id;
  customerB = (await dbInternal.customer.create({ data: { orgId, name: "Beta GmbH", addressLine1: "B 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } })).id;

  await invoice(customerA, 100000, APRIL);          // April: 1.000 €
  await invoice(customerA, 50000, MAY);             // Mai:     500 €
  await invoice(customerB, 30000, MAY);             // Mai:     300 €
  await invoice(customerA, 20000, MAY, "CREDIT_NOTE"); // Mai:  -200 €
  await invoice(customerB, 999999, MAY, "INVOICE", false); // Entwurf -> zaehlt nicht
});

describe("monthlyRevenue", () => {
  it("liefert 12 lueckenlose Monate, summiert netto und zieht Gutschriften ab", async () => {
    const rows = await monthlyRevenue(orgId, { now: NOW });
    expect(rows).toHaveLength(12);
    expect(rows[0].month).toBe("2084-07");
    expect(rows[11].month).toBe("2085-06");
    expect(rows.find((r) => r.month === "2085-04")?.netCents).toBe(100000);
    const may = rows.find((r) => r.month === "2085-05");
    expect(may?.netCents).toBe(50000 + 30000 - 20000);   // Entwurf (999.999) zaehlt NICHT mit
    expect(may?.count).toBe(3);
  });

  it("filtert nach Kunde und ist org-gescoped", async () => {
    const b = await monthlyRevenue(orgId, { customerId: customerB, now: NOW });
    expect(b.find((r) => r.month === "2085-05")?.netCents).toBe(30000);
    expect(b.find((r) => r.month === "2085-04")?.netCents).toBe(0);
    const other = await dbInternal.organization.create({ data: { legalName: "Fremd GmbH", addressLine1: "F 1", postalCode: "10115", city: "Berlin" } });
    expect((await monthlyRevenue(other.id, { now: NOW })).every((r) => r.netCents === 0)).toBe(true);
  });

  it("monthKey und netShareCents sind reine Funktionen", () => {
    expect(monthKey(new Date(Date.UTC(2085, 0, 31, 23, 59, 59)))).toBe("2085-01");
    expect(netShareCents({ netTotalCents: 10000, grossTotalCents: 11900, payableCents: null })).toBe(10000);
    // Schlussrechnung: 11.900 brutto, davon 5.950 zahlbar -> halbes Netto.
    expect(netShareCents({ netTotalCents: 10000, grossTotalCents: 11900, payableCents: 5950 })).toBe(5000);
    expect(netShareCents({ netTotalCents: 10000, grossTotalCents: 0, payableCents: 0 })).toBe(0);
  });
});

describe("topCustomers", () => {
  it("sortiert absteigend nach Netto, zaehlt Belege, schneidet bei limit", async () => {
    const rows = await topCustomers(orgId, { months: 12, limit: 5, now: NOW });
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows[0]).toMatchObject({ name: "Alpha AG", netCents: 100000 + 50000, invoiceCount: 3 });
    expect(rows[1]).toMatchObject({ name: "Beta GmbH", netCents: 30000 - 20000 });
  });
  it("liefert eine leere Liste ohne Belege", async () => {
    const other = await dbInternal.organization.create({ data: { legalName: "Leer GmbH", addressLine1: "L 1", postalCode: "10115", city: "Berlin" } });
    expect(await topCustomers(other.id, { now: NOW })).toEqual([]);
  });
});
```
> Die Gutschrift wird hier über `type: "CREDIT_NOTE"` mit positiven Positionsbeträgen angelegt; `monthlyRevenue` dreht das Vorzeichen anhand des Typs. Vor dem Schreiben prüfen, ob `createDraftInvoice` für `CREDIT_NOTE` positive oder negative Beträge erwartet (`src/domain/invoice/credit.ts` gegenlesen) — **die Testerwartung an den tatsächlichen Code anpassen, nicht umgekehrt.**

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/reporting-revenue.test.ts`.

- [ ] **Step 3: `revenue.ts` schreiben**

```ts
// src/domain/reporting/revenue.ts
/**
 * Umsatzreihe je Kalendermonat (Phase 12e). Rein lesend, org-gescoped, DB-portabel:
 * `select`-reduzierte Zeilen + Aggregation in JS — dieselbe Begruendung wie in
 * src/domain/dashboard/summary.ts (SQLite/Postgres, keine DB-spezifischen Funktionen).
 * Monatsgrenzen in UTC (Date.UTC), damit die Reihe unabhaengig von der Container-Zeitzone
 * ist (Konvention aus src/lib/date-only.ts).
 *
 * Basis ist NETTO. Bei einer Abschlagskette (§14) traegt die Schlussrechnung in
 * `payableCents` den bereits um die Abschlaege reduzierten Betrag; ein rohes
 * `netTotalCents` wuerde den Abschlag doppelt zaehlen (derselbe Fehler, den die Fix-Welle
 * S2 fuer `grossTotalCents` behoben hat). `netShareCents` skaliert deshalb proportional.
 */
import { dbInternal } from "@/lib/db";
import { roundHalfUp } from "@/lib/money";

export interface MonthlyRevenuePoint { month: string; netCents: number; count: number }
export interface MonthlyRevenueOptions { months?: number; customerId?: string; now?: Date }

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function netShareCents(inv: { netTotalCents: number; grossTotalCents: number; payableCents: number | null }): number {
  if (inv.payableCents === null) return inv.netTotalCents;
  if (inv.grossTotalCents === 0) return 0;
  return roundHalfUp((inv.netTotalCents * inv.payableCents) / inv.grossTotalCents);
}

export async function monthlyRevenue(orgId: string, opts: MonthlyRevenueOptions = {}): Promise<MonthlyRevenuePoint[]> {
  const months = opts.months ?? 12;
  const now = opts.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

  const rows = await dbInternal.invoice.findMany({
    where: {
      orgId,
      status: { notIn: ["DRAFT", "CANCELLED"] },
      issueDate: { gte: start, lt: end },
      ...(opts.customerId ? { customerId: opts.customerId } : {}),
    },
    select: { issueDate: true, type: true, netTotalCents: true, grossTotalCents: true, payableCents: true },
  });

  const buckets = new Map<string, MonthlyRevenuePoint>();
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    buckets.set(monthKey(d), { month: monthKey(d), netCents: 0, count: 0 });
  }
  for (const r of rows) {
    const bucket = buckets.get(monthKey(r.issueDate));
    if (!bucket) continue;
    const sign = r.type === "CREDIT_NOTE" ? -1 : 1;
    bucket.netCents += sign * netShareCents(r);
    bucket.count += 1;
  }
  return [...buckets.values()];
}
```

- [ ] **Step 4: `customers.ts` schreiben**

`topCustomers` lädt dieselbe Menge (`status notIn DRAFT/CANCELLED`, `issueDate` im Fenster) mit `select: { customerId, type, netTotalCents, grossTotalCents, payableCents, customer: { select: { name: true } } }`, summiert je `customerId` in einer `Map`, sortiert absteigend nach `netCents` und schneidet bei `limit` (Default 5). `months` Default 12, Fenster wie oben. Modulkommentar: dieselbe Portabilitäts-Begründung, Verweis auf `netShareCents` (kein zweites Vorzeichen-/Anteilsverfahren).

- [ ] **Step 5: Gate + Commit**

Run: `TZ=UTC npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/domain/reporting test/integration/reporting-revenue.test.ts
git commit -s -m "feat(reporting): Umsatz je Monat und Top-Kunden als reine Aggregationsfunktionen (Phase 12e, Task 2)"
```

---

### Task 3: Auswertungen — Status und Zahlungsverhalten

**Files:**
- Create: `src/domain/reporting/status.ts`, `src/domain/reporting/payment-behaviour.ts`, `test/integration/reporting-behaviour.test.ts`

**Befund (verifiziert):** `effectiveInvoiceStatus({ status, dueDate, issueDate }, now)` (`src/domain/invoice/status.ts:59`) liefert `DRAFT | FINALIZED | OPEN | DUE | OVERDUE | PARTIALLY_PAID | PAID | CANCELLED`; `INVOICE_STATUS_LABEL` (Z. 33) liefert die deutschen Beschriftungen. `Payment` (Schema Z. 443) hat `invoiceId`, `amountCents`, `paidAt`, `isSkonto` und **kein** `orgId` — die Org-Zugehörigkeit läuft über die Relation `invoice`. `openAmountCents` (`amounts.ts:22`) liefert den Restbetrag.

**Ruling (kein Doppelbau):** `paymentBehaviour` liefert **nicht** `openCents` — den kennt `customerOverview().kpis.openCents` bzw. `dashboardSummary().openInvoices.cents` bereits (§1.4). Die Spec nennt `openCents` im Rückgabetyp; die Kundenseite bezieht ihn weiterhin aus `customerOverview`.

**Interfaces:**
```ts
// src/domain/reporting/status.ts
export interface StatusCount { status: EffectiveInvoiceStatus; label: string; count: number; openCents: number }
export async function statusCounts(orgId: string, now?: Date): Promise<StatusCount[]>;   // nur Status mit count > 0

// src/domain/reporting/payment-behaviour.ts
export interface PaymentBehaviour {
  /** Mittelwert der Tage zwischen Rechnungsdatum und letzter Zahlung; null ohne bezahlte Rechnung. */
  avgDaysToPay: number | null;
  /** Anteil der bis zum Faelligkeitstag bezahlten Rechnungen (0..1); null ohne Faelligkeitsdatum. */
  onTimeShare: number | null;
  paidCount: number;
}
export async function paymentBehaviour(orgId: string, opts?: { customerId?: string }): Promise<PaymentBehaviour>;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/reporting-behaviour.test.ts
/**
 * Phase 12e, Task 3 — statusCounts und paymentBehaviour. Eigenes Jahr 2086
 * (Testjahr-Konvention), eigener Nummernkreis-Praefix. Alle Tagesgrenzen UTC.
 * Faelle nach Lastenheft §54: Grenzfall "am Faelligkeitstag bezahlt" gilt als puenktlich,
 * Division durch Null bei null Zahlungen liefert null statt NaN.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { statusCounts } from "@/domain/reporting/status";
import { paymentBehaviour } from "@/domain/reporting/payment-behaviour";
import type { CreateInvoiceInput } from "@/schemas";

const ISSUE = new Date(Date.UTC(2086, 2, 1, 10, 0, 0));
const NOW = new Date(Date.UTC(2086, 3, 20, 10, 0, 0));
let orgId: string;
let customerId: string;

function line(netCents: number) {
  return { description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 0 as const, taxCategory: "Z" as const, discountPermille: 0 };
}

/** Rechnung mit Faelligkeit anlegen, festschreiben, optional voll bezahlen. */
async function make(netCents: number, due: Date, paidAt?: Date) {
  const inv = await createDraftInvoice(orgId, { customerId, type: "INVOICE", taxScheme: "KLEINUNTERNEHMER", currency: "EUR", issueDate: ISSUE, lines: [line(netCents)] } as CreateInvoiceInput, { now: ISSUE });
  await dbInternal.invoice.update({ where: { id: inv.id }, data: { dueDate: due } });
  await finalizeInvoice(inv.id, { now: ISSUE });
  if (paidAt) await recordPayment(inv.id, { amountCents: netCents, paidAt, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId });
  return inv;
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Verhalten Test GmbH", addressLine1: "Zahlweg 1", postalCode: "10115", city: "Berlin", vatId: "DE866666666", taxNumber: "86/666/66666", smallBusiness: true },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Zahlkunde AG", addressLine1: "Z 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } })).id;

  await make(10000, new Date(Date.UTC(2086, 2, 15)), new Date(Date.UTC(2086, 2, 12))); // puenktlich, 11 Tage
  await make(20000, new Date(Date.UTC(2086, 2, 15)), new Date(Date.UTC(2086, 2, 25))); // 10 Tage zu spaet, 24 Tage
  await make(30000, new Date(Date.UTC(2086, 3, 10)));                                   // offen -> OVERDUE zu NOW
});

describe("statusCounts", () => {
  it("zaehlt je effektivem Status, liefert offenen Betrag, deutsche Labels, keine leeren Eintraege", async () => {
    const rows = await statusCounts(orgId, NOW);
    expect(rows.every((r) => r.count > 0)).toBe(true);
    expect(rows.find((r) => r.status === "PAID")).toMatchObject({ count: 2, openCents: 0 });
    expect(rows.find((r) => r.status === "OVERDUE")).toMatchObject({ count: 1, openCents: 30000, label: "Überfällig" });
  });
});

describe("paymentBehaviour", () => {
  it("mittelt die Tage bis zur Zahlung und den Puenktlichkeitsanteil", async () => {
    const b = await paymentBehaviour(orgId, { customerId });
    expect(b.paidCount).toBe(2);
    expect(b.avgDaysToPay).toBe(18);      // (11 + 24) / 2 = 17,5 -> kaufmaennisch 18
    expect(b.onTimeShare).toBe(0.5);
  });
  it("ohne bezahlte Rechnung: null statt NaN", async () => {
    const other = await dbInternal.organization.create({ data: { legalName: "Ohne Zahlung GmbH", addressLine1: "O 1", postalCode: "10115", city: "Berlin" } });
    expect(await paymentBehaviour(other.id)).toEqual({ paidCount: 0, avgDaysToPay: null, onTimeShare: null });
  });
  it("am Faelligkeitstag bezahlt gilt als puenktlich", async () => {
    await make(5000, new Date(Date.UTC(2086, 2, 20)), new Date(Date.UTC(2086, 2, 20)));
    const b = await paymentBehaviour(orgId, { customerId });
    expect(b.paidCount).toBe(3);
    expect(b.onTimeShare).toBeCloseTo(2 / 3, 5);
  });
});
```
> Signatur verifiziert: `recordPayment(invoiceId, input, opts)` mit `opts: { actor?, now?, orgId? }` (`src/domain/invoice/payment.ts:54`) — **nicht** `(orgId, id, …, actor)`. Die Feldmenge des Inputs (`isSkonto`/`applySkonto`) ist aus `test/integration/dashboard-overview.test.ts:87` übernommen; vor dem Schreiben gegen `recordPaymentSchema` (`src/schemas/index.ts`) gegenlesen.

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/reporting-behaviour.test.ts`.

- [ ] **Step 3: `status.ts` schreiben**

Lädt `invoice.findMany({ where: { orgId }, select: { status, dueDate, issueDate, grossTotalCents, paidAmountCents, payableCents } })`, bildet je Zeile `effectiveInvoiceStatus(...)`, zählt in einer `Map<EffectiveInvoiceStatus, StatusCount>` und summiert `openAmountCents(inv)` **nur** für `OPEN`/`DUE`/`OVERDUE`/`PARTIALLY_PAID` (bei `PAID`/`CANCELLED`/`DRAFT` bleibt `openCents` 0). Rückgabe in der festen Reihenfolge von `INVOICE_STATUS_LABEL`, Einträge mit `count === 0` entfallen. Modulkommentar: „ergänzt `dashboardSummary` um die dort fehlende PAID-Zahl (fürs Ringdiagramm) — die Kacheln bleiben bei `dashboardSummary` (§1.4)".

- [ ] **Step 4: `payment-behaviour.ts` schreiben**

```ts
const invoices = await dbInternal.invoice.findMany({
  where: { orgId, status: "PAID", ...(opts.customerId ? { customerId: opts.customerId } : {}) },
  select: { id: true, issueDate: true, dueDate: true, payments: { select: { paidAt: true }, orderBy: { paidAt: "desc" }, take: 1 } },
});
```
> **Vor dem Schreiben prüfen**, wie die Relation auf `Invoice` heißt (`grep -n "Payment\[\]" prisma/schema.prisma`) — der Feldname wird übernommen, nicht geraten.

Je Rechnung: `settledAt` = die späteste Zahlung; `days = (utcDateOnly(settledAt) - utcDateOnly(issueDate)) / DAY_MS`; `onTime = dueDate ? utcDateOnly(settledAt) <= utcDateOnly(dueDate) : null`. `avgDaysToPay = paidCount === 0 ? null : roundHalfUp(sumDays / paidCount)`; `onTimeShare = withDueDate === 0 ? null : onTimeCount / withDueDate`. Rechnungen ohne Zahlungszeile (z. B. per Statuswechsel auf PAID gesetzt) werden übersprungen und zählen nicht in `paidCount` — als Kommentar festhalten.

- [ ] **Step 5: Gate + Commit**

Run: `TZ=UTC npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/domain/reporting test/integration/reporting-behaviour.test.ts
git commit -s -m "feat(reporting): Statusverteilung und Zahlungsverhalten als reine Funktionen (Phase 12e, Task 3)"
```

---

### Task 4: Dashboard und Kunden-Detailseite verdrahten

**Files:**
- Modify: `src/app/page.tsx:82-100`, `src/components/dashboard/DashboardWidgets.tsx:1-89`, `src/components/dashboard/AgingChart.tsx:1-31`, `src/app/kunden/[id]/page.tsx:21-66`
- Create: `test/unit/dashboard-charts.test.tsx`

**Befund (verifiziert):** `src/app/page.tsx` lädt heute nur `dashboardSummary(org.id)` und rendert `<DashboardWidgets summary={summary} />`. `DashboardWidgets` zeigt acht Kacheln und darunter ein zweispaltiges Raster mit `AgingChart` und „Letzte Belege". `AgingChart({ aging }: { aging: AgingBucket[] })` bekommt bereits fertige Buckets mit `label`/`count`/`cents`. Die Kundenseite zeigt drei KPI-Kacheln (`kpis.openCents`, `kpis.overdueCents`, `kpis.totalRevenueCents`) und danach `<CustomerTabs tabs={[…]} />` mit vier Reitern; `CustomerTabs` ist ein generischer Umschalter und bleibt unverändert.

**Ruling (Reihenfolge, Spec-Präzisierung):** Die Zeitreihe steht auf der Kundenseite **über** den Reitern (Spec: „weniger Klicks, entspricht sevDesk"), die zwei neuen KPI-Kacheln erweitern die bestehende Reihe von drei auf fünf (`sm:grid-cols-3` → `sm:grid-cols-3 lg:grid-cols-5`).

- [ ] **Step 1: Failing test schreiben**

```tsx
// test/unit/dashboard-charts.test.tsx
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
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/dashboard-charts.test.tsx`.

- [ ] **Step 3: `chart-data.ts` (Aufbereitung, ohne DB)**

Neu `src/components/dashboard/chart-data.ts` (~70 Zeilen, reine Funktionen — damit die Widgets testbar bleiben, ohne React zu rendern):
- `revenueChartData(points: MonthlyRevenuePoint[]): ChartDatum[]` — Label über `new Intl.DateTimeFormat("de-DE", { month: "short", year: "2-digit", timeZone: "UTC" })` auf `new Date(`${month}-01T00:00:00Z`)`, `valueLabel` über `formatCents`.
- `statusDonutData(rows: StatusCount[]): ChartDatum[]` — drei feste Segmente: „Offen" (`OPEN` + `DUE` + `PARTIALLY_PAID`), „Überfällig" (`OVERDUE`), „Bezahlt" (`PAID`), Farben `CHART_COLORS.primary` / `.overdue` / `.second`, `valueLabel` = „n Rechnung(en)". Segmente mit `value === 0` bleiben in der Liste (der Donut ignoriert sie geometrisch, die Legende bleibt vollständig).
- `topCustomerChartData(rows: TopCustomer[]): ChartDatum[]` — Name auf 24 Zeichen gekürzt (mit „…"), `valueLabel` über `formatCents`.
- `agingChartData(buckets: AgingBucket[]): ChartDatum[]` — `valueLabel` = `${formatCents(cents)} (${count})`, Farbe `CHART_COLORS.due`.

- [ ] **Step 4: Dashboard**
  - `src/app/page.tsx`: neben `dashboardSummary` zusätzlich `monthlyRevenue(org.id)`, `statusCounts(org.id)` und `topCustomers(org.id)` in einem `Promise.all` laden und als Props an `DashboardWidgets` reichen (`revenue`, `statuses`, `top`).
  - `DashboardWidgets.tsx`: unter den Kacheln, **über** dem bestehenden zweispaltigen Raster, eine volle Breite:
    ```tsx
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <BarChart title="Umsatz je Monat (netto, 12 Monate)" data={revenueChartData(revenue)} />
    </div>
    ```
    Danach das bestehende Raster von zwei auf drei Karten erweitern: `DonutChart` „Offen / Überfällig / Bezahlt" (`statusDonutData`), `BarChart` waagerecht „Top 5 Kunden" (`topCustomerChartData`) und die unveränderte Karte „Letzte Belege"; die Aging-Karte bleibt, wo sie ist. Raster: `grid gap-6 lg:grid-cols-2` bleibt, die dritte Karte reiht sich ein.
  - `AgingChart.tsx`: Datei und Exportname bleiben, der Rumpf wird zu
    ```tsx
    export function AgingChart({ aging }: { aging: AgingBucket[] }) {
      return <BarChart title="Überfällig nach Alter" data={agingChartData(aging)} orientation="horizontal" />;
    }
    ```
    Die Überschrift `<h2>` in `DashboardWidgets` (Z. 66) entfällt, weil `ChartFrame` bereits eine `<figcaption>` rendert — sonst stünde der Titel doppelt.

- [ ] **Step 5: Kunden-Detailseite**
  - `src/app/kunden/[id]/page.tsx`: neben `customerOverview` zusätzlich `monthlyRevenue(org.id, { customerId: id })` und `paymentBehaviour(org.id, { customerId: id })` laden (`Promise.all`).
  - KPI-Reihe von `sm:grid-cols-3` auf `sm:grid-cols-3 lg:grid-cols-5` und zwei Kacheln ergänzen:
    - „Ø Zahlungsdauer": `behaviour.avgDaysToPay === null ? "—" : `${behaviour.avgDaysToPay} Tage``
    - „Pünktlich bezahlt": `behaviour.onTimeShare === null ? "—" : `${Math.round(behaviour.onTimeShare * 100)} %`` — grün ab 80 %, amber darunter (`text-emerald-700` / `text-amber-700`).
  - **Über** `<CustomerTabs …>`:
    ```tsx
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <LineChart title="Umsatz je Monat (netto, 12 Monate)" data={revenueChartData(revenue)} />
    </div>
    ```
  - `CustomerTabs` bleibt unverändert (generischer Umschalter, kein fünfter Reiter).

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build`
```bash
git add src/app/page.tsx src/app/kunden src/components/dashboard test/unit/dashboard-charts.test.tsx
git commit -s -m "feat(dashboard): Umsatzreihe, Statusring und Top-5-Kunden auf Uebersicht und Kundenseite (Phase 12e, Task 4)"
```

---

### Task 5: Report-Schnittstelle, Doku, Smoke, Gesamtprüfung

**Files:**
- Modify: `src/mcp/tools/system.ts`, `docs/ANLEITUNG.md`, `docs/ARCHITEKTUR.md`, `docs/LIMITATIONEN.md`, `docs/API.md`, `docs/MCP.md`, `openapi/openapi.json`
- Create: `src/domain/reporting/query.ts`, `src/app/api/v1/Report/route.ts`, `test/integration/report-resource.test.ts`

**Befund (verifiziert):** `discoverRouteSpecs()` (`src/api/openapi.ts:82`) **wirft**, wenn eine Route unter `src/app/api/v1/**` keinen `spec`-Export hat — der Export ist Pflicht. `RouteSpec.method` (`src/api/spec.ts:32`) kennt nur `GET | POST | PATCH`; die Ressource ist rein lesend. `Report` ist **keine** CRUD-Ressource und braucht deshalb **keinen** Eintrag in `RESOURCE_SCHEMAS` (die Überschreibung dort greift nur für `/api/v1/<Resource>`-Basispfade mit Serialisierer) — `apiDataResponseSchema(z.unknown())` genügt, wie bei den Aktions-Endpunkten.

**Interfaces:**
```ts
// src/domain/reporting/query.ts
export const reportQuerySchema = z.object({
  type: z.enum(["revenue", "top-customers", "status", "payment-behaviour"]),
  months: z.coerce.number().int().min(1).max(36).default(12),
  limit: z.coerce.number().int().min(1).max(50).default(5),
  customerId: z.string().min(1).optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export async function runReport(orgId: string, raw: unknown, now?: Date): Promise<unknown>;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/report-resource.test.ts
/** Phase 12e, Task 5 — GET /api/v1/Report. Eigenes Jahr 2087 (Testjahr-Konvention). */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { dbInternal } from "@/lib/db";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { GET } from "@/app/api/v1/Report/route";
import { runReport, reportQuerySchema } from "@/domain/reporting/query";

let orgId: string;
let token: string;

function req(url: string, withToken = true) {
  const headers = new Headers();
  if (withToken) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { headers });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Report-API GmbH", addressLine1: "R 1", postalCode: "10115", city: "Berlin", vatId: "DE877777777", taxNumber: "87/777/77777" },
  });
  orgId = org.id;
  token = (await createApiKey(orgId, { name: "Report-Leser", scopes: ["read"], expiresAt: null })).token;
});

beforeEach(() => resetRateLimits());

describe("reportQuerySchema", () => {
  it("verlangt einen bekannten Typ und setzt Defaults", () => {
    expect(reportQuerySchema.safeParse({}).success).toBe(false);
    expect(reportQuerySchema.safeParse({ type: "unsinn" }).success).toBe(false);
    expect(reportQuerySchema.parse({ type: "revenue" })).toMatchObject({ months: 12, limit: 5 });
  });
});

describe("GET /api/v1/Report", () => {
  it("revenue liefert 12 Monatspunkte", async () => {
    const res = await GET(req("http://x/api/v1/Report?type=revenue"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.data.type).toBe("revenue");
    expect(j.data.rows).toHaveLength(12);
  });
  it("unbekannter Typ -> 400 VALIDATION", async () => {
    const res = await GET(req("http://x/api/v1/Report?type=unsinn"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION");
  });
  it("ohne Token -> 401", async () => {
    expect((await GET(req("http://x/api/v1/Report?type=status", false))).status).toBe(401);
  });
  it("runReport ist der gemeinsame Kern von REST und MCP", async () => {
    const direct = (await runReport(orgId, { type: "status" })) as { type: string };
    expect(direct.type).toBe("status");
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/report-resource.test.ts`.

- [ ] **Step 3: `query.ts` und die Route**

`runReport(orgId, raw, now)` parst mit `reportQuerySchema` und schaltet auf die vier Funktionen um; Rückgabe einheitlich `{ objectName: "Report", type, rows }` (bei `payment-behaviour` `{ …, rows: [behaviour] }`, damit die Form stabil bleibt). Die Route:
```ts
export const GET = withApi(async (req, ctx) => {
  const { searchParams } = new URL(req.url);
  return apiData(await runReport(ctx.orgId, Object.fromEntries(searchParams)));
}, { scope: "read" });

export const spec = {
  get: {
    path: "/api/v1/Report",
    method: "GET",
    summary: "Auswertung abrufen (revenue | top-customers | status | payment-behaviour)",
    scope: "read",
    request: { query: reportQuerySchema },
    response: apiDataResponseSchema(z.unknown()),
    errors: [400, 401, 403, 429],
  },
} satisfies Record<string, RouteSpec>;
```

- [ ] **Step 4: MCP-Tool `get_report`**

In `src/mcp/tools/system.ts` (neben `get_dashboard`, falls vorhanden — sonst nach `get_status`), mit denselben Parametern wie `reportQuerySchema` und `runReport` als Kern:
```ts
server.registerTool(
  "get_report",
  {
    title: "Auswertung abrufen",
    description:
      "Liefert eine Auswertung (Phase 12e): revenue (Netto-Umsatz je Monat, Gutschriften abgezogen), top-customers (nach Netto), status (Rechnungen je effektivem Status) oder payment-behaviour (Ø Tage bis zur Zahlung, Puenktlichkeitsanteil). Optional je Kunde (customerId) und ueber n Monate (months, Default 12).",
    inputSchema: {
      type: z.enum(["revenue", "top-customers", "status", "payment-behaviour"]),
      months: z.number().int().min(1).max(36).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      customerId: z.string().optional(),
    },
  },
  async (args): Promise<Result> => {
    try {
      const org = await ctx.requireOrg();
      return ctx.ok(JSON.stringify(await runReport(org.id, args), null, 2));
    } catch (e) {
      if (e instanceof ToolError) return ctx.fail(e.message);
      return ctx.failUnknown(e);
    }
  },
);
```

- [ ] **Step 5: Doku**
  - **ANLEITUNG.md:** Abschnitt „Übersicht" — welche vier Diagramme es gibt, was sie zählen (netto, ohne Entwürfe und Stornos, Gutschriften abgezogen) und dass die Werte per Tooltip und für Screenreader als Tabelle verfügbar sind. Abschnitt „Kunden" — Zeitreihe, Ø Zahlungsdauer und Pünktlichkeitsanteil erklären.
  - **ARCHITEKTUR.md:** `src/domain/reporting/*` und `src/components/charts/*` in die Modulübersicht; **den Absatz zu `netShareCents`** (Abschlagsketten, warum nicht `netTotalCents` roh) aufnehmen; Hinweis „Aggregation in JS, nicht in der DB — Portabilität SQLite/Postgres".
  - **LIMITATIONEN.md:** vier Sätze — (1) „Die Diagramme sind statisch (SVG, serverseitig gerendert): kein Zoom, kein Filtern im Bild." (2) „Es gibt keinen Export der Auswertungen als CSV oder PDF." (3) „Der Umsatz ist eine Netto-Auswertung nach Rechnungsdatum, keine Einnahmen-Überschuss-Rechnung und keine Buchhaltung (Lastenheft §60)." (4) „Rechnungen ohne erfasste Zahlung, die manuell auf PAID gesetzt wurden, gehen nicht in die Ø Zahlungsdauer ein."
  - **API.md:** `GET /api/v1/Report` mit allen vier Typen, Parametern und Beispielantwort.
  - **MCP.md:** `get_report` in die Werkzeugliste.

- [ ] **Step 6: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots nach `<scratchpad>/ui-previews/12e-*.png`):
  1. `/` → alle vier Diagramme rendern, **keine** Konsolenfehler, kein `NaN` im DOM (`page.content()` prüfen).
  2. Mauszeiger über einen Balken → nativer Tooltip mit Monat und Betrag (per `getAttribute` auf dem `<title>` verifizieren, da native Tooltips nicht screenshotbar sind).
  3. `/kunden/<id>` eines Kunden mit mehreren Rechnungen → Linie über zwölf Monate, fünf KPI-Kacheln, Reiter darunter unverändert bedienbar.
  4. Fenster auf 400 px Breite verkleinern → kein waagerechtes Scrollen der Seite, Diagramme skalieren (`viewBox`).
  5. Eine Organisation ohne Belege (frischer Seed-Zustand oder zweiter Kunde ohne Rechnungen) → „Keine Daten im gewählten Zeitraum." statt eines leeren Kastens.
  Konsolenfehler protokollieren; kein CI-Gate.

- [ ] **Step 7: Gesamtprüfung + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`
`api:check` schlägt an (neue Route) ⇒ `npm run api:check -- --write`, Diff mitcommitten, erneut prüfen. Mit Docker zusätzlich `bash scripts/test-postgres-migrations.sh` (unverändert — Phase 12e hat keine Migration).
```bash
git add src/domain/reporting src/app/api/v1/Report src/mcp/tools/system.ts docs openapi/openapi.json test/integration/report-resource.test.ts
git commit -s -m "feat(reporting): GET /api/v1/Report, MCP get_report und Doku (Phase 12e, Task 5)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. **Keine neue Abhängigkeit:** `git diff main -- package.json package-lock.json` ist leer. Kein `import` aus einer Chart-Bibliothek; die vier Chart-Dateien enthalten nur JSX und Arithmetik.
2. **Keine Attrappe (§59):** `grep -rn "LineChart\|DonutChart\|BarChart" src/app src/components --include=*.tsx` zeigt für jede der drei Komponenten mindestens einen echten Konsumenten — `LineChart` auf der Kundenseite (Ruling), `DonutChart` und `BarChart` auf dem Dashboard, `BarChart` zusätzlich in `AgingChart`.
3. **Nichts doppelt gebaut (§1.4):** `dashboardSummary` und `customerOverview` sind unverändert und bleiben die Quelle der Kacheln; `statusCounts` liefert nur die dort fehlende PAID-Zahl; `paymentBehaviour` liefert **kein** `openCents`. `AgingChart.tsx` hat denselben Dateinamen und denselben Export wie vorher; die doppelte Überschrift in `DashboardWidgets` ist entfernt.
4. **Geld und Rundung:** kein Float in den Aggregaten; `netShareCents` rundet mit `roundHalfUp`; jede Anzeige geht über `formatCents`. `onTimeShare` ist der einzige Bruch und ist als Anteil 0..1 dokumentiert.
5. **Abschlagsketten:** `netShareCents` skaliert `netTotalCents` proportional zu `payableCents/grossTotalCents` — eine Abschlags- plus Schlussrechnung summiert genau den Netto-Auftragswert, nicht das Doppelte. Der Unit-Fall dazu ist grün, die Regel steht in `docs/ARCHITEKTUR.md`.
6. **Zeitzonen:** alle Monatsgrenzen über `Date.UTC`/`utcDateOnly`; `TZ=UTC npm test` **und** ein Lauf ohne `TZ` (lokal Europe/Berlin) sind beide grün — der Grenzfall „Rechnung am Monatsersten 00:30 Ortszeit" landet in beiden Läufen im selben Monat.
7. **Robustheit:** kein `NaN`/`Infinity`/`undefined` im gerenderten SVG bei leeren Daten, lauter Nullwerten, einem einzelnen Punkt oder negativen Monatswerten (Testfälle vorhanden). Division durch Null ist an jeder Stelle abgefangen (`Math.max(1, …)`, `total === 0`, `paidCount === 0`).
8. **Barrierefreiheit:** jedes Diagramm hat `role="img"` + `aria-label`, jedes Segment ein `<title>`, und unter jedem SVG steht die `sr-only`-Wertetabelle. Die `.sr-only`-Klasse ist tatsächlich wirksam (Utility vorhanden **oder** eigene Regel in `globals.css`) — im Browser mit dem Element-Inspektor gegengeprüft.
9. **Responsiv:** `viewBox` + `preserveAspectRatio` + `w-full h-auto`; bei 400 px Fensterbreite scrollt die Seite nicht waagerecht (Smoke-Schritt 4).
10. **Server-Komponenten:** keine der Chart- und Reporting-Dateien trägt `"use client"`; die Seiten bleiben Server-Komponenten, es gibt keine Funktions-Props über eine Client-Grenze.
11. **Schnittstellen:** `/api/v1/Report` exportiert `spec` (sonst wirft `discoverRouteSpecs`), ist Scope `read` und nur lesend; `reportQuerySchema` validiert REST **und** MCP (ein Schema, kein zweites für `get_report`); `openapi/openapi.json` regeneriert, `npm run api:check` grün.
12. **Bestand:** keine Migration, Tabellenzahl unverändert 45; `test/integration/dashboard-overview.test.ts` und alle übrigen Bestandstests laufen unverändert durch.
13. **Smoke:** Screenshots von Dashboard und Kundenseite ohne Konsolenfehler. Betreiberfrage: „Wirken Übersicht und Kundenseite jetzt modern — und stimmen die Zahlen mit deinen Rechnungen überein?"
