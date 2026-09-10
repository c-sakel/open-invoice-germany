# Phase 13a — Listen: Breite, Status-Tabs, Kopfkennzahlen, Sofortfilter, Herkunft

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die vier Listen (`/rechnungen`, `/dokumente`, `/lieferscheine`, `/abos`) bedienbar machen wie moderne Rechnungsdienste: volle Seitenbreite, Status-Tabs mit Zählern statt Filterformular mit Knopf, Kopfkennzahlen über der **gefilterten** Menge (nicht über die angezeigte Seite), relative Fälligkeit und Herkunft je Zeile, Zeilenaktionen ohne zweite Aktionsmatrix. Kein Schemawechsel, keine Migration, kein Schreibpfad — Phase 13a liest ausschließlich.

**Architecture:** Fünf Bausteine. (1) `AppShell` gibt die Breite frei, die neue Server-Komponente `PageContainer` hält Formularseiten schmal. (2) Zwei neue reine Module (`src/lib/relative-date.ts`, `src/domain/document/origin.ts`) liefern die zwei fehlenden Zeilenangaben, `originsFor` bulk (kein N+1). (3) Die Listendomänen bekommen je einen Zähl- und (bei Rechnungen) einen Kennzahleneinstieg, die sich den **bestehenden** Where-Builder mit `listInvoices`/`listQuotes` teilen — kein zweiter Statusbegriff. (4) `billingStateFor` wird in eine reine Ableitungsfunktion (`deriveBillingState`) plus zwei Ladewege zerlegt: pro Beleg (Detailseite, unverändert) und als Bulk-Index (`billingStateIndex`) für Tab-Zähler, Tab-Filter und Zeilen-Chip. (5) `FilterBar` wird Client-Komponente und navigiert bei jeder Änderung selbst; der Knopf „Filtern" entfällt.

**Tech Stack:** Next.js App Router (Server Components + `searchParams`), Tailwind v4, Prisma (SQLite + Postgres), Zod, Vitest (`environment: "node"`, **kein RTL** ⇒ keine Komponententests, nur Helfer-Unit- und Domain-Integrationstests), Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-10-phase-13-listen-editor-beleg-design.md` — Paket **A** (Abschnitt 2, „Seitenbreite" bis „Zeilenaktionen"), Struktur 3/A, Tests 4/A, Teilphase 1 in Abschnitt 5.

## Global Constraints

- Branch `phase-13a/listen` aus Fork-`main` (eb4c847 oder neuer). Jeder Commit mit `git commit -s`.
- **Nur lesen.** Kein Prisma-Modell, keine Migration, kein neuer Schreibpfad, `src/lib/db.ts` unberührt.
- Nichts doppelt bauen (§1.4): `statusWhere`, `listInvoices`/`listQuotes`/`listDeliveryNotes`/`listRecurring`, `availableActions`, `RowActionsMenu`, `DocumentActionsMenuItems`, `PaymentForm`, `ConvertMenu`, `StatusBadge`/`BillingStateBadge`, `loadListPage`, `parseListQuery`, `openAmountCents`, `effectiveInvoiceStatus`, `utcDateOnly` werden erweitert, nicht kopiert.
- Kein N+1: jede neue Listenangabe wird für die ganze Seite in einer festen, zeilenzahl-unabhängigen Zahl Abfragen geladen. Zod bleibt die Grenze: neue Filterfelder nur über `invoiceListFilterSchema` (`src/schemas/index.ts:565`), `quoteListFilterSchema`/`deliveryNoteListFilterSchema` (`src/domain/document/list.ts:40/151`).
- Tagesgrenzen ausschließlich über `utcDateOnly`/`utcDateOnlyPlusDays` (`src/lib/date-only.ts`) — CI läuft UTC, lokal Europe/Berlin.
- Geld bleibt Integer-Cent; Summen DB-seitig (`groupBy`) oder über `openAmountCents` in JS — nie von der Seite hochgerechnet.
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen. Deutsche UI-Texte mit echten Umlauten.
- `quoteListFilterSchema`/`deliveryNoteListFilterSchema` stecken in `/api/v1/Quote`, `/api/v1/OrderConfirmation`, `/api/v1/DeliveryNote` ⇒ jede Erweiterung erzeugt OpenAPI-Drift: `npm run api:check -- --write`, `openapi/openapi.json` mitcommitten, dann `npm run api:check` erneut.
- **Prüfkette** (in jedem „Gate + Commit"-Schritt gemeint, im Vordergrund, Timeout 600000 ms): `npm run typecheck && npm run lint && TZ=UTC npm test`. Vor dem letzten Commit zusätzlich `build`, `validate:erechnung`, `api:check`. Die 2067 Bestandstests bleiben grün (§1.7).

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/components/shell/AppShell.tsx:40,42` | `max-w-6xl` → `max-w-[1600px]` (main **und** footer) |
| `src/components/PageContainer.tsx` | neu — Server-Komponente, `width: "wide" \| "form"` |
| `src/app/einstellungen/layout.tsx` | neu — hüllt alle 16 Einstellungsseiten in `width="form"` |
| `src/app/kunden/{neu,[id]/bearbeiten}/page.tsx`, `src/app/produkte/{neu,[id]}/page.tsx` | `PageContainer width="form"` |
| `src/lib/relative-date.ts` | neu — `relativeDueLabel(due, now)` |
| `src/domain/document/origin.ts` | neu — `originsFor(orgId, kind, ids)` (Bulk) |
| `src/components/list/{StatusTabs,ListHeadline,RowPaymentDialog}.tsx` | neu; `{FilterBar,RowActionsMenu}.tsx` — Sofortfilter, Direktknöpfe, `CONVERT`, Statuswechsel |
| `src/domain/invoice/list.ts` | `invoiceFilterConditions`, `invoiceStatusTabCounts`, `invoiceListHeadline` |
| `src/domain/document/list.ts` | `quoteFilterConditions`/`quoteStatusWhere`, drei `…StatusTabCounts`, `tag`/`minCents` im Schema |
| `src/domain/document/billing-state.ts` | `deriveBillingState` (rein) + `billingStateIndex` (Bulk, `cache()`) |
| `src/domain/document/actions.ts` | `convertTargets()` + ActionKey `CONVERT` |
| `src/domain/document/neighbors.ts:22` | `ALLOWED_KEYS` + `minCents`, `maxCents`, `paymentMethodId`, `eInvoice`, `tag` |
| `src/schemas/index.ts:565` | `invoiceListFilterSchema.tag` |
| `src/app/{rechnungen,dokumente,lieferscheine,abos}/page.tsx` | Tabs, Kennzahlen, neue Spalten/Felder |
| `src/app/dokumente/[id]/page.tsx:48-51,130-136` | vier lokale Status-Sets → `convertTargets()` |
| `test/unit/{page-width,relative-date,document-origin,list-filter-keys,document-actions}.test.ts`, `test/integration/{list-tabs,list-headline,billing-state-index}.test.ts` | Helfer/Matrix bzw. Domain gegen echte DB |
| `docs/{ANLEITUNG,LIMITATIONEN,ARCHITEKTUR}.md` | Doku |

### Task 1: Seitenbreite und `PageContainer`

**Files:** Create `src/components/PageContainer.tsx`, `src/app/einstellungen/layout.tsx`, `test/unit/page-width.test.ts` · Modify `src/components/shell/AppShell.tsx:40,42`, `src/app/kunden/neu/page.tsx`, `src/app/kunden/[id]/bearbeiten/page.tsx`, `src/app/produkte/neu/page.tsx`, `src/app/produkte/[id]/page.tsx`

- [ ] **Step 1: Failing test schreiben** — `test/unit/page-width.test.ts`, Strukturtest (environment `node`, kein RTL; Muster `test/unit/dialogs.test.ts`), drei Behauptungen über den Dateiinhalt: `AppShell.tsx` enthält **kein** `max-w-6xl` mehr und genau **zwei** `max-w-[1600px]` (main + footer); `PageContainer.tsx` enthält `max-w-4xl` und **kein** `"use client"`; `app/einstellungen/layout.tsx` existiert und matcht `/PageContainer[\s\S]*width="form"/`.

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/page-width.test.ts`.

- [ ] **Step 3: `PageContainer` schreiben**

```tsx
// src/components/PageContainer.tsx
import type { ReactNode } from "react";
/**
 * Breitenrahmen einer Seite (Phase 13a). `AppShell` gibt seit dieser Phase 1600 px frei —
 * gewollt fuer Listen/Editor/Belegansicht, unlesbar fuer ein Stammdaten- oder
 * Einstellungsformular (Zeilenlaenge). Server-Komponente ohne Zustand; bewusst nur die
 * zwei Faelle, die es gibt.
 */
export function PageContainer({ width, children }: { width: "wide" | "form"; children: ReactNode }) {
  return <div className={width === "form" ? "mx-auto w-full max-w-4xl" : "w-full"}>{children}</div>;
}
```

- [ ] **Step 4: `AppShell` freigeben** — Z. 40 (`main`) und Z. 42 (`footer`): `max-w-6xl` → `max-w-[1600px]` (beide, sonst steht die Fußzeile schmaler als der Inhalt). `SlimShell` bleibt unverändert.

- [ ] **Step 5: Formularseiten einhüllen** — neue `src/app/einstellungen/layout.tsx`: `export default function EinstellungenLayout({ children }: { children: ReactNode }) { return <PageContainer width="form">{children}</PageContainer>; }` (ein Layout statt 16 Seitenänderungen). In den vier Kunden-/Produktformularseiten das äußerste `<div className="space-y-6">` in `<PageContainer width="form">` einschließen. **Nicht** anfassen: `kunden/page.tsx`, `kunden/[id]/page.tsx`, `produkte/page.tsx` (Listen/Detail dürfen breit laufen).

- [ ] **Step 6: Gate + Commit** — Prüfkette, dann:
```bash
git add src/components/PageContainer.tsx src/components/shell/AppShell.tsx src/app/einstellungen/layout.tsx src/app/kunden src/app/produkte test/unit/page-width.test.ts
git commit -s -m "feat(ui): volle Seitenbreite mit PageContainer fuer Formularseiten (Phase 13a, Task 1)"
```

### Task 2: Relative Fälligkeit und Herkunft je Zeile

**Files:** Create `src/lib/relative-date.ts`, `src/domain/document/origin.ts`, `test/unit/relative-date.test.ts`, `test/unit/document-origin.test.ts`

**Interfaces:** `relativeDueLabel(due: Date | null | undefined, now?: Date): { text: string; overdue: boolean; days: number | null }` · `originsFor(orgId: string, kind: "INVOICE" | "DELIVERY_NOTE", ids: readonly string[]): Promise<Map<string, { href: string; label: string }>>`

- [ ] **Step 1: Failing tests schreiben**

```ts
// test/unit/relative-date.test.ts — NOW = 2064-03-15T09:30Z, d(y,m,day) = new Date(Date.UTC(...))
expect(relativeDueLabel(d(2064, 2, 15), NOW)).toEqual({ text: "heute fällig", overdue: false, days: 0 });
expect(relativeDueLabel(d(2064, 2, 16), NOW).text).toBe("morgen fällig");
expect(relativeDueLabel(d(2064, 2, 29), NOW).text).toBe("in 14 Tagen");
expect(relativeDueLabel(d(2064, 2, 14), NOW)).toEqual({ text: "seit 1 Tag überfällig", overdue: true, days: -1 });
expect(relativeDueLabel(d(2064, 2, 12), NOW).text).toBe("seit 3 Tagen überfällig");
expect(relativeDueLabel(null, NOW)).toEqual({ text: "—", overdue: false, days: null });
expect(relativeDueLabel(d(2065, 0, 2), new Date(Date.UTC(2064, 11, 31, 23, 0))).text).toBe("in 2 Tagen"); // Jahreswechsel
expect(relativeDueLabel(d(2064, 2, 15), new Date(Date.UTC(2064, 2, 15, 23, 59))).days).toBe(0); // Tagesrand
```
```ts
// test/unit/document-origin.test.ts — Kernaussage: KEIN N+1. prisma per vi.mock auf einen
// Proxy, dessen jedes Modell dasselbe `findMany`-Spy liefert.
it("50 Zeilen kosten eine feste, zeilenzahl-unabhaengige Zahl Abfragen", async () => {
  findMany.mockResolvedValue([]);
  await originsFor("org1", "INVOICE", Array.from({ length: 50 }, (_, i) => `inv${i}`));
  expect(findMany.mock.calls.length).toBeLessThanOrEqual(2); // ohne Treffer keine Quellabfrage
});
it("leere Id-Liste fragt gar nicht", async () => {
  expect((await originsFor("org1", "INVOICE", [])).size).toBe(0);
  expect(findMany).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/relative-date.test.ts test/unit/document-origin.test.ts`.

- [ ] **Step 3: `relativeDueLabel` schreiben**

```ts
// src/lib/relative-date.ts
/**
 * Relative Faelligkeit fuer Listen und Belegansicht (Phase 13a). Bewusst reine
 * Tagesdifferenz statt Intl.RelativeTimeFormat (das ab ~7 Tagen auf Wochen/Monate
 * umschaltet — fuer ein Zahlungsziel unbrauchbar). Tagesgrenze in UTC ueber utcDateOnly:
 * dieselbe Konvention wie effectiveInvoiceStatus/listInvoices/dunning (date-only.ts) —
 * sonst zeigt die Liste nachts zwei Stunden "ueberfaellig", waehrend der Mahnlauf noch
 * "nicht faellig" sagt.
 */
import { utcDateOnly } from "./date-only";
export interface RelativeDue { text: string; overdue: boolean; days: number | null }
const DAY_MS = 24 * 60 * 60 * 1000;

export function relativeDueLabel(due: Date | null | undefined, now: Date = new Date()): RelativeDue {
  if (!due) return { text: "—", overdue: false, days: null };
  const days = Math.round((utcDateOnly(due) - utcDateOnly(now)) / DAY_MS);
  if (days === 0) return { text: "heute fällig", overdue: false, days };
  if (days === 1) return { text: "morgen fällig", overdue: false, days };
  if (days > 1) return { text: `in ${days} Tagen`, overdue: false, days };
  if (days === -1) return { text: "seit 1 Tag überfällig", overdue: true, days };
  return { text: `seit ${-days} Tagen überfällig`, overdue: true, days };
}
```

- [ ] **Step 4: `originsFor` schreiben** — Modulkommentar: „Herkunft für eine ganze Listenseite; zwei Quellen in dieser Reihenfolge: die denormalisierten Felder am Beleg (`Invoice.sourceType/sourceId`, `Invoice.recurringInvoiceId`, `DeliveryNote.sourceType/sourceId`) und — nur für Belege ohne solche — die `CONVERTED_TO`-Relation. Feste Abfragezahl (2 + max. 4 Quellabfragen), kein zweiter Relationsbegriff neben `src/domain/relations.ts`."

```ts
export async function originsFor(orgId: string, kind: OriginKind, ids: readonly string[]): Promise<Map<string, OriginRef>> {
  const out = new Map<string, OriginRef>();
  if (ids.length === 0) return out;
  const idList = [...ids];
  const rows = kind === "INVOICE"
    ? await prisma.invoice.findMany({ where: { orgId, id: { in: idList } }, select: { id: true, sourceType: true, sourceId: true, recurringInvoiceId: true } })
    : await prisma.deliveryNote.findMany({ where: { orgId, id: { in: idList } }, select: { id: true, sourceType: true, sourceId: true } });
  const source = new Map<string, { type: "QUOTE" | "INVOICE" | "DELIVERY_NOTE" | "RECURRING"; id: string }>();
  for (const r of rows) {
    const recurringId = "recurringInvoiceId" in r ? r.recurringInvoiceId : null;
    if (r.sourceType && r.sourceId) source.set(r.id, { type: r.sourceType as "QUOTE" | "DELIVERY_NOTE", id: r.sourceId });
    else if (recurringId) source.set(r.id, { type: "RECURRING", id: recurringId });
  }
  // Belege ohne denormalisierte Quelle: CONVERTED_TO zeigt VON der Quelle AUF den Beleg
  // (src/domain/document/convert.ts) — eine Abfrage fuer alle fehlenden Ids.
  const missing = idList.filter((id) => !source.has(id));
  if (missing.length > 0) {
    const rels = await prisma.documentRelation.findMany({
      where: { orgId, relationType: "CONVERTED_TO", toType: kind, toId: { in: missing } },
      select: { fromType: true, fromId: true, toId: true }, orderBy: { createdAt: "asc" },
    });
    for (const rel of rels) if (!source.has(rel.toId)) source.set(rel.toId, { type: rel.fromType as "QUOTE", id: rel.fromId });
  }
  /* Je Quelltyp GENAU EINE Nummernabfrage (quote/invoice/deliveryNote/recurringInvoice, nur bei
     anfallenden Ids, in einem Promise.all) -> Map `${type}:${id}` -> OriginRef. Labels: "aus
     Angebot AN-1094" (Quote.kind ueber QUOTE_KIND_LABEL), "aus Auftragsbestaetigung …", "aus
     Proforma-Rechnung …", "aus Rechnung RE-…", "aus Lieferschein LS-…", "aus Abo <title>";
     number null (Entwurf) ⇒ "(Entwurf)". hrefs: /dokumente|/rechnungen|/lieferscheine|/abos. */
  return out;
}
```

- [ ] **Step 5: Gate + Commit** — Prüfkette **plus** `TZ=Europe/Berlin npx vitest run test/unit/relative-date.test.ts`, dann:
```bash
git add src/lib/relative-date.ts src/domain/document/origin.ts test/unit/relative-date.test.ts test/unit/document-origin.test.ts
git commit -s -m "feat(listen): relative Faelligkeit und Herkunft je Zeile (Phase 13a, Task 2)"
```

### Task 3: Status-Tabs und Tab-Zähler

**Files:** Create `src/components/list/StatusTabs.tsx`, `test/integration/list-tabs.test.ts` · Modify `src/domain/invoice/list.ts`, `src/domain/document/list.ts`

**Ruling (Abweichung von der Spec, begründet):** Die Spec fordert als Test „Summe aller Tabs außer ‚Alle' ergibt ‚Alle'". Das ist mit der bestehenden Statussemantik falsch: `statusWhere` (`invoice/list.ts:59`, Fix S1) zählt eine teilbezahlte Rechnung mit Restbetrag sowohl unter `partial` (Rohstatus `PARTIALLY_PAID`) als auch unter `open`/`due`/`overdue`. Ein disjunkter Neu-Statusbegriff wäre genau die verbotene Doppelung. Geprüft wird deshalb (a) `draft + open + due + overdue + paid + cancelled === all` (diese sechs **sind** disjunkt und vollständig) und (b) für **jeden** Tab `count === listInvoices({status: tab}).total` — die stärkere Aussage, die jede Abweichung zwischen Zähler und Liste ausschließt.

**Interfaces:** `invoiceFilterConditions(orgId, filter: InvoiceListFilter): Prisma.InvoiceWhereInput[]` · `invoiceStatusTabCounts(orgId, rawFilter: unknown, now?: Date): Promise<Record<InvoiceListStatusFilter, number>>` · `quoteStatusTabCounts(…): Promise<Record<string, number | null>>` · `deliveryNoteStatusTabCounts(orgId, rawFilter)` · `recurringStatusTabCounts(orgId, rawFilter)`

- [ ] **Step 1: Failing test schreiben** — `test/integration/list-tabs.test.ts` nach dem Muster von `test/integration/invoice-list.test.ts` (eigenes Jahr **2064**, weil `Invoice.number` instanzweit `@unique` ist und `test.db` geteilt wird). `beforeAll` legt an: Entwurf, offen (fällig 2064-06-25), fällig heute, überfällig (2064-06-14), teilbezahlt+überfällig, bezahlt, storniert — plus **eine** Rechnung in einer zweiten Organisation.

```ts
const NOW = new Date(Date.UTC(2064, 5, 15, 10, 0));
it("jeder Tab zaehlt genau so viele Zeilen, wie die Liste mit diesem Status liefert", async () => {
  const counts = await invoiceStatusTabCounts(orgId, {}, NOW);
  for (const tab of InvoiceListStatusFilter.options) {
    expect({ tab, n: counts[tab] }).toEqual({ tab, n: (await listInvoices(orgId, { status: tab, limit: 200 }, NOW)).total });
  }
});
it("die sechs disjunkten Tabs ergeben zusammen 'Alle'", async () => {
  const c = await invoiceStatusTabCounts(orgId, {}, NOW);
  expect(c.draft + c.open + c.due + c.overdue + c.paid + c.cancelled).toBe(c.all);
});
it("ein Textfilter wirkt auf ALLE Zaehler, eine fremde Organisation zaehlt nicht mit", async () => {
  const c = await invoiceStatusTabCounts(orgId, { q: "Zaehlertest" }, NOW);
  expect(c.all).toBe((await listInvoices(orgId, { q: "Zaehlertest", limit: 200 }, NOW)).total);
  expect((await invoiceStatusTabCounts(otherOrgId, {}, NOW)).all).toBe(1);
});
```

  Dazu je ein Fall für `quoteStatusTabCounts` (EXPIRED zählt abgelaufene DRAFT/SENT, `archiviert` wirkt) und `deliveryNoteStatusTabCounts`.

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/list-tabs.test.ts`.

- [ ] **Step 3: Where-Builder herausziehen** — den Block `src/domain/invoice/list.ts:104-152` (zwischen `const and = [{ orgId }]` und `const where = { AND: and }`, **ohne** `statusCond`) unverändert in `invoiceFilterConditions(orgId, filter)` verschieben; `listInvoices` ruft sie und hängt `statusWhere(filter.status, now)` an. Analog in `src/domain/document/list.ts`: der `status`-Block von `listQuotes` (Z. 84-95, inkl. EXPIRED-/DRAFT-/SENT-Sonderfälle) wird `quoteStatusWhere(status, now)`, der Rest `quoteFilterConditions(orgId, filter)`. Reine Umstellung — die Bestandstests `invoice-list.test.ts`/`list-routes.test.ts` sind die Abnahme.

- [ ] **Step 4: Zähler schreiben**

```ts
// src/domain/invoice/list.ts (ergaenzt)
/**
 * Zeilenzahl je Status-Tab fuer dieselbe Filtermenge (Phase 13a): je Tab ein `count()`
 * mit demselben `where` wie die Liste, nur mit ausgetauschter Statusbedingung — keine
 * Zeilen im Speicher, kein zweiter Statusbegriff. Bewusst ueberlappend, wo `statusWhere`
 * es ist: `partial` (Rohstatus PARTIALLY_PAID) ist Teilmenge von open/due/overdue.
 */
export async function invoiceStatusTabCounts(orgId: string, rawFilter: unknown, now: Date = new Date()) {
  const filter = invoiceListFilterSchema.parse(rawFilter);
  const base = invoiceFilterConditions(orgId, filter);
  const tabs = InvoiceListStatusFilter.options;
  const counts = await Promise.all(tabs.map((tab) => {
    const cond = statusWhere(tab, now);
    return prisma.invoice.count({ where: { AND: cond ? [...base, cond] : base } });
  }));
  return Object.fromEntries(tabs.map((t, i) => [t, counts[i]])) as Record<InvoiceListStatusFilter, number>;
}
```
  In `document/list.ts` dasselbe `Promise.all`-Muster für `["all", ...QuoteStatus.options]` (über `quoteStatusWhere`), `["all", ...DeliveryNoteStatus.options]` und `["all", "ACTIVE", "PAUSED", "ENDED"]`.

- [ ] **Step 5: `StatusTabs` schreiben** — reine Server-Komponente, kein Client-JS:

```tsx
// src/components/list/StatusTabs.tsx
/**
 * Status-Tabs ueber einer Liste (Phase 13a, §40) — Links auf `?status=…`. `offset` faellt
 * beim Tabwechsel weg (neue Auswahl beginnt auf Seite 1), alle uebrigen Filter bleiben.
 * `count: null` zeigt keine Zahl — z. B. wenn der Zaehler mangels Daten nicht berechenbar
 * ist (billingStateIndex-Obergrenze, Task 5): lieber keine Zahl als eine falsche.
 */
export interface StatusTab { value: string; label: string; count?: number | null }

export function StatusTabs({ basePath, searchParams, tabs, active }: {
  basePath: string; searchParams: Record<string, string | undefined>; tabs: StatusTab[]; active: string;
}) {
  function hrefFor(value: string): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) if (v && k !== "offset" && k !== "status") p.set(k, v);
    if (value !== "all") p.set("status", value);
    return p.toString() ? `${basePath}?${p.toString()}` : basePath;
  }
  /* <nav aria-label="Status" class="flex flex-wrap gap-1 border-b border-slate-200"> mit je
     <Link href={hrefFor(t.value)} aria-current={t.value === active ? "page" : undefined}>; aktiv
     "-mb-px border-b-2 border-indigo-600 px-3 py-2 text-sm font-medium text-indigo-700", sonst
     "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"; Zaehler als
     <span class="tabular ml-1.5 text-xs text-slate-400"> nur bei count != null. */
}
```

- [ ] **Step 6: Gate + Commit** — Prüfkette, dann:
```bash
git add src/domain/invoice/list.ts src/domain/document/list.ts src/components/list/StatusTabs.tsx test/integration/list-tabs.test.ts
git commit -s -m "feat(listen): Status-Tabs mit Zaehlern aus dem bestehenden Where-Builder (Phase 13a, Task 3)"
```

### Task 4: Kopfkennzahlen über der Rechnungsliste  ⚠ Task-Review (Geld)

**Files:** Create `src/components/list/ListHeadline.tsx`, `test/integration/list-headline.test.ts` · Modify `src/domain/invoice/list.ts`

**Ruling:** Die Summenzeile „nur diese Seite" (`rechnungen/page.tsx:90-95`) entfällt ersatzlos — sie war laut Codekommentar eine Auslassung des Phase-8b-Task-1-Vertrags, keine fachliche Entscheidung. Währungen werden **nicht** stillschweigend addiert: `groupBy({ by: ["currency"] })` liefert die Verteilung in derselben Abfrage; bei mehr als einer Währung setzt `mixedCurrency`, und die Anzeige hängt „(gemischte Währungen)" an, statt eine falsche Zahl zu behaupten.

**Interfaces:** `invoiceListHeadline(orgId, rawFilter: unknown, now?: Date): Promise<InvoiceListHeadline>` mit `InvoiceListHeadline = { count: number; grossCents: number; openCents: number; overdueCents: number; currency: string; mixedCurrency: boolean }`

- [ ] **Step 1: Failing test schreiben** — `test/integration/list-headline.test.ts` (Jahr **2065**) gegen handgerechnete Werte. Sechs Rechnungen: 2 offen (119,00 € + 238,00 €), 1 überfällig (100,00 €), 1 teilbezahlt+überfällig (Brutto 200,00 €, Zahlung 50,00 € ⇒ offen 150,00 €), 1 bezahlt (300,00 €), 1 Entwurf (50,00 €). Erwartet: `count` = 6 und `grossCents` = Σ **aller** sechs (auch Entwurf/bezahlt); `openCents` = 119,00 + 238,00 + 100,00 + 150,00 (Entwurf zählt nicht — `effectiveInvoiceStatus` liefert DRAFT); `overdueCents` = 100,00 + 150,00. Vier weitere Fälle: Schlussrechnung mit `payableCents` < `grossTotalCents` ⇒ `openCents` folgt `openAmountCents`, nicht `gross − paid`; überzahlte Rechnung ⇒ `openCents` **nicht** negativ; `{ status: "overdue" }` ⇒ `count` = 2 und `grossCents` = Σ der beiden überfälligen (Kennzahlen folgen dem Filter); zweite Währung (CHF) ⇒ `mixedCurrency === true`.

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/list-headline.test.ts`.

- [ ] **Step 3: `invoiceListHeadline` schreiben**

```ts
// src/domain/invoice/list.ts (ergaenzt)
/**
 * Kopfkennzahlen ueber der GEFILTERTEN Menge (Phase 13a) — ersetzt die "nur diese Seite"-
 * Summe. Zwei Abfragen: (1) groupBy ueber `currency` liefert Anzahl + Σ Brutto DB-seitig
 * und exakt, dazu die Waehrungsverteilung (kein stilles Addieren ueber Waehrungen);
 * (2) findMany NUR ueber den potenziell offenen Teil (FINALIZED/SENT/PARTIALLY_PAID) mit
 * vier Int-Spalten — offen/ueberfaellig aus openAmountCents + effectiveInvoiceStatus,
 * dasselbe DB-portable JS-Aggregat wie dashboardSummary.
 */
export async function invoiceListHeadline(orgId: string, rawFilter: unknown, now: Date = new Date()): Promise<InvoiceListHeadline> {
  const filter = invoiceListFilterSchema.parse(rawFilter);
  const base = invoiceFilterConditions(orgId, filter);
  const statusCond = statusWhere(filter.status, now);
  const and = statusCond ? [...base, statusCond] : base;
  const [groups, openish] = await Promise.all([
    prisma.invoice.groupBy({ by: ["currency"], where: { AND: and }, _count: { _all: true }, _sum: { grossTotalCents: true } }),
    prisma.invoice.findMany({
      where: { AND: [...and, { status: { in: ["FINALIZED", "SENT", "PARTIALLY_PAID"] } }] },
      select: { status: true, dueDate: true, issueDate: true, grossTotalCents: true, paidAmountCents: true, payableCents: true },
    }),
  ]);
  let openCents = 0, overdueCents = 0;
  for (const inv of openish) {
    const status = effectiveInvoiceStatus({ status: inv.status, dueDate: inv.dueDate, issueDate: inv.issueDate }, now);
    if (status !== "OPEN" && status !== "DUE" && status !== "OVERDUE") continue;
    const open = openAmountCents(inv); // klemmt bereits auf >= 0 — keine eigene Formel
    openCents += open;
    if (status === "OVERDUE") overdueCents += open;
  }
  const leading = [...groups].sort((a, b) => b._count._all - a._count._all)[0];
  return {
    count: groups.reduce((s, g) => s + g._count._all, 0),
    grossCents: groups.reduce((s, g) => s + (g._sum.grossTotalCents ?? 0), 0),
    openCents, overdueCents, currency: leading?.currency ?? "EUR", mixedCurrency: groups.length > 1,
  };
}
```

- [ ] **Step 4: `ListHeadline` schreiben** — reine Anzeige, jede Zahl kommt aus einer Domain-Funktion über die **gefilterte** Menge, nie aus den sichtbaren Zeilen:

```tsx
// src/components/list/ListHeadline.tsx
export interface HeadlineItem { label: string; value: string; tone?: "default" | "danger"; hint?: string }
/* <dl class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">, je Eintrag eine Karte
   ("rounded-lg border border-slate-200 bg-white px-4 py-3") mit <dt> (uppercase, xs,
   slate-500), <dd> ("tabular mt-1 text-xl font-semibold", danger ⇒ text-rose-700) und
   optionalem <p> fuer `hint`. */
export function ListHeadline({ items }: { items: HeadlineItem[] }) { /* … */ }
```

- [ ] **Step 5: Gate + Commit** — Prüfkette, dann:
```bash
git add src/domain/invoice/list.ts src/components/list/ListHeadline.tsx test/integration/list-headline.test.ts
git commit -s -m "feat(listen): Kopfkennzahlen ueber der gefilterten Menge statt Seitensumme (Phase 13a, Task 4)"
```

### Task 5: `deriveBillingState` und `billingStateIndex`  ⚠ Task-Review (Fachlogik/Geld)

**Files:** Create `test/integration/billing-state-index.test.ts` · Modify `src/domain/document/billing-state.ts`, `src/domain/document/list.ts`

**Ruling (Abweichung von der Spec, begründet):** Die Spec nennt „**zwei** Queries" und einen Zähler-Mock, der genau zwei erwartet. Mit Äquivalenz zu `billingStateFor` ist das nicht erreichbar: dessen FULL-Regel prüft neben Relationen und Rechnungsstatus auch (a) die **Bruttosumme des Angebots** (`billedPermille`) und (b) die **Mengendeckung** über `billedQuantities` (`QuoteLine` × `InvoiceLine.sourceLineId`). Zwei Abfragen könnten (a)/(b) nicht liefern — der Index zeigte bei 100 % mengengedeckten Teilrechnungen PARTIAL statt FULL, also eine falsche Zahl im Tab. Umgesetzt werden **fünf** Bulk-Abfragen (Relationen, Rechnungen, Angebots-Brutto, Angebotspositionen, abgerechnete Mengen), die letzten beiden nur bei vorhandener `PARTIAL_OF`-Relation. Getestet wird, was die Spec meint: **konstante, zeilenzahl-unabhängige Abfragezahl** und **exakte Äquivalenz** zu `billingStateFor`.

**Interfaces:**
```ts
export interface BillingStateFacts {
  quoteGrossCents: number;
  converted: { id: string; cancelled: boolean }[];              // CONVERTED_TO -> Rechnung
  finals: { id: string; finalized: boolean }[];                 // FINAL_FOR
  partials: { id: string; grossTotalCents: number; cancelled: boolean }[];
  downpayments: { id: string; grossTotalCents: number; cancelled: boolean }[];
  allQuantitiesBilled: boolean;                                 // nur bei vorhandenen Teilrechnungen
}
export function deriveBillingState(f: BillingStateFacts): BillingStateResult;
export const BILLING_INDEX_RELATION_LIMIT = 20_000;
export const billingStateIndex: (orgId: string) => Promise<{ available: boolean; states: Map<string, BillingState> }>;
```

- [ ] **Step 1: Failing test schreiben** — `test/integration/billing-state-index.test.ts` (Jahr **2066**) baut zehn Angebote: ohne Rechnung · umgewandelt · umgewandelt+storniert · ein Abschlag 30 % · Abschläge zusammen 100 % · Teilrechnung über **alle** Mengen · Teilrechnung über halbe Mengen · festgeschriebene Schlussrechnung · Schlussrechnung nur als Entwurf · nur stornierte Teilrechnungen.

```ts
it("liefert fuer jede Konstellation exakt dasselbe wie billingStateFor", async () => {
  const index = await billingStateIndex(orgId);
  expect(index.available).toBe(true);
  for (const [name, quoteId] of Object.entries(quoteIds)) {
    const single = await billingStateFor(orgId, "QUOTE", quoteId);
    expect({ name, state: index.states.get(quoteId) }).toEqual({ name, state: single.state });
  }
});
it("der Index ruft nie die Einzelabfrage und bleibt bei hoechstens fuenf Bulk-Abfragen", () => {
  const body = readFileSync("src/domain/document/billing-state.ts", "utf8").split("export const billingStateIndex")[1];
  expect(body).not.toMatch(/billingStateFor/);
  expect((body.match(/findMany|groupBy/g) ?? []).length).toBeLessThanOrEqual(5);
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/billing-state-index.test.ts`.

- [ ] **Step 3: `deriveBillingState` herausziehen** — die Entscheidungskette aus `billing-state.ts:38-114` **wortgleich** in eine reine Funktion über `BillingStateFacts` überführen (Reihenfolge: FULL durch Umwandlung → FULL durch festgeschriebene Schlussrechnung → PARTIAL/FULL durch Betrags- oder Mengendeckung → NONE; inklusive `billedPermille`, `downpaymentGrossCents`, `hasActiveFinal`). `billingStateFor` behält seine Abfragen und ruft am Ende nur noch `deriveBillingState(facts)`. Abnahme: `test/integration/document-chain.test.ts` und `partial-invoices*.test.ts` bleiben **unverändert** grün.

- [ ] **Step 4: `billingStateIndex` schreiben**

```ts
// src/domain/document/billing-state.ts (ergaenzt)
import { cache } from "react";
/** Ab dieser Zahl Relationszeilen je Organisation wird kein Index gebaut — die zwei
 *  abgeleiteten Tabs entfallen dann (Hinweis statt falscher Zahl, siehe LIMITATIONEN). */
export const BILLING_INDEX_RELATION_LIMIT = 20_000;

/**
 * Abrechnungsstand ALLER Angebote/ABs einer Organisation in konstant vielen Abfragen
 * (Phase 13a) — speist Tab-Zaehler, Tab-Filter (`id: { in }`) und den Zeilen-Chip. Teilt
 * sich mit `billingStateFor` die Regeln (deriveBillingState); je Anfrage ueber React
 * `cache()` memoisiert (Muster: src/domain/settings/brand.ts), damit Zaehler, Filter und
 * Zeilen denselben Index sehen.
 */
export const billingStateIndex = cache(async (orgId: string): Promise<BillingStateIndex> => {
  const relations = await dbInternal.documentRelation.findMany({
    where: { orgId, OR: [
      { fromType: "QUOTE", toType: "INVOICE", relationType: "CONVERTED_TO" },
      { fromType: "INVOICE", toType: "QUOTE", relationType: { in: ["PARTIAL_OF", "DOWNPAYMENT_OF", "FINAL_FOR"] } },
    ] },
    select: { fromId: true, toId: true, fromType: true, relationType: true },
    take: BILLING_INDEX_RELATION_LIMIT + 1,
  });
  if (relations.length > BILLING_INDEX_RELATION_LIMIT) return { available: false, states: new Map() };
  /* Gruppierung je quoteId (CONVERTED_TO ueber toId/fromId, die drei uebrigen umgekehrt —
     identische Richtungslogik wie billingStateFor:44-47), danach: invoice.findMany(id in
     alleReferenzierten, orgId; select id/status/grossTotalCents), quote.findMany(id in
     quoteIds, orgId; select id/grossTotalCents) und NUR bei vorhandenen PARTIAL_OF-Relationen
     quoteLine.findMany(quoteId in …, lineType "ITEM") + invoiceLine.groupBy(by sourceLineId,
     where WOERTLICH aus billedQuantities (billed-quantities.ts:33), nur sourceId: { in: … }).
     Dann je quoteId `deriveBillingState(facts)` und `states.set(quoteId, result.state)`. */
});
```

- [ ] **Step 5: Zwei abgeleitete Tabs verdrahten** — `quoteStatusTabCounts` liefert `billed`/`partially-billed` über `id: { in: [...] }`, solange der Index `available` ist, sonst `null` (⇒ `StatusTabs` zeigt keine Zahl, `/dokumente` blendet beide Tabs ganz aus). Der Filter `?status=billed` wird **vor** `listQuotes` in `and.push({ id: { in: ids } })` übersetzt, **nicht** in `quoteStatusWhere` — das ist der Belegstatus, nicht der Abrechnungsstand.

- [ ] **Step 6: Gate + Commit** — Prüfkette, dann:
```bash
git add src/domain/document/billing-state.ts src/domain/document/list.ts test/integration/billing-state-index.test.ts
git commit -s -m "feat(dokumente): Abrechnungsstand als Bulk-Index mit geteilter Ableitung (Phase 13a, Task 5)"
```

### Task 6: `FilterBar` ohne Knopf, neue Feldtypen, Filterumfang

**Files:** Create `test/unit/list-filter-keys.test.ts` · Modify `src/components/list/FilterBar.tsx`, `src/schemas/index.ts:565`, `src/domain/document/list.ts`, `src/domain/document/neighbors.ts:22`

**Ruling:** Das `combo`-Feld (Kontakt) setzt bei **exaktem** Treffer in der `<datalist>` `customerId`; freier Text ohne Treffer setzt **keinen** Filter — statt `q` zu überschreiben, das ein eigenes Feld derselben Leiste ist (zwei Felder dürfen sich keinen Parameter teilen). Das `<form method="get">` bleibt als JS-freier Rückfall; der sichtbare Knopf „Filtern" entfällt, ein `sr-only`-Submit bleibt für Tastatur/ohne JS. **`tag` wird in 13a nur akzeptiert und weitergereicht, nicht ausgewertet** (Auflösung erst mit dem `Tag`-Modell in 13d) — damit das keine Attrappe ist, erscheint `tag` in 13a in **keiner** Filterleiste, nur im Schema und in `ALLOWED_KEYS`.

- [ ] **Step 1: Failing test schreiben** — jeder angebotene Filter MUSS die Detailseite überleben (`ALLOWED_KEYS`) **und** im Zod-Schema stehen; sonst filtert die Leiste sichtbar, und „Zurück zur Liste" verwirft es stillschweigend:

```ts
// test/unit/list-filter-keys.test.ts
const KEYS = ["q", "status", "type", "customerId", "minCents", "maxCents", "from", "to", "paymentMethodId", "eInvoice", "tag"];
it("alle Rechnungsfilter ueberleben Detailseite -> Zurueck zur Liste", () => {
  const round = parseListeQuery(buildListeParam(Object.fromEntries(KEYS.map((k) => [k, k === "eInvoice" ? "true" : "1"]))));
  for (const k of KEYS) expect({ k, kept: round?.has(k) }).toEqual({ k, kept: true });
});
it("die neuen Filter sind Teil der Zod-Schemata", () => {
  expect(invoiceListFilterSchema.parse({ tag: "t1", minCents: "500" })).toMatchObject({ tag: "t1", minCents: 500 });
  expect(quoteListFilterSchema.parse({ customerId: "c1", tag: "t1", minCents: "500" })).toMatchObject({ tag: "t1", minCents: 500 });
  expect(deliveryNoteListFilterSchema.parse({ customerId: "c1", tag: "t1" })).toMatchObject({ tag: "t1" });
});
it("unbekannte Schluessel fallen weiterhin heraus", () => {
  expect(parseListeQuery(buildListeParam({ boese: "1", q: "x" }))?.has("boese")).toBe(false);
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/list-filter-keys.test.ts`.

- [ ] **Step 3: Schemata und `ALLOWED_KEYS` erweitern**
  - `src/schemas/index.ts:565`: `tag: z.string().min(1).optional()` (alles andere ist bereits da).
  - `src/domain/document/list.ts:40` `quoteListFilterSchema`: `tag` + `minCents`/`maxCents` (`z.coerce.number().int().optional()`, wirken auf `grossTotalCents`); Z. 151 `deliveryNoteListFilterSchema`: `tag`. `customerId` steckt bereits in `baseFilterShape`.
  - `src/domain/document/neighbors.ts:22`: `"minCents", "maxCents", "paymentMethodId", "eInvoice", "tag"` ergänzen.

- [ ] **Step 4: `FilterBar` umstellen**

```tsx
// src/components/list/FilterBar.tsx (jetzt "use client")
/**
 * Filterleiste (Phase 8b, umgebaut in Phase 13a): jede Aenderung navigiert selbst —
 * Selects/Datumsfelder sofort, Text-/Betragsfelder 300 ms entprellt, kein Knopf "Filtern"
 * mehr. Das <form method="get"> bleibt als JS-freier Rueckfall (Enter sendet nativ, dazu
 * ein sr-only-Submit); `offset` wird bei jeder Aenderung verworfen.
 */
export type FilterField =
  | { type: "text"; name: string; label: string; placeholder?: string }
  | { type: "select"; name: string; label: string; options: { value: string; label: string }[] }
  | { type: "date"; name: string; label: string }
  | { type: "number"; name: string; label: string; placeholder?: string }   // Euro -> Cent-Parameter
  | { type: "combo"; name: string; label: string; options: { value: string; label: string }[] }; // <datalist> -> Id

const DEBOUNCE_MS = 300;

export function FilterBar({ basePath, fields, values }: {
  basePath: string; fields: FilterField[]; values: Record<string, string | undefined>;
}) {
  const router = useRouter();
  // Beim Mount aus `values` gefuellt und danach NICHT per Effekt nachgezogen — sonst
  // ueberschreibt die Antwort des router.replace die gerade getippte Eingabe.
  const [local, setLocal] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, values[f.name] ?? ""])));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function navigate(next: Record<string, string>) {
    const p = new URLSearchParams();
    // Werte ohne eigenes Feld (`type` der Gutschriften-Navigation, `archiviert`) bleiben.
    for (const [k, v] of Object.entries(values)) if (v && k !== "offset" && !fields.some((f) => f.name === k)) p.set(k, v);
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    router.replace(p.toString() ? `${basePath}?${p.toString()}` : basePath, { scroll: false });
  }
  /* `change(name, raw, debounce, map?)` setzt `local`, verwirft einen laufenden Timer und
     ruft `navigate({ ...next, [name]: map ? map(raw) : raw })` — sofort oder nach
     DEBOUNCE_MS. Je Feldtyp ein <label> mit `inputCls` (@/components/forms/fields):
     text -> change(n, v, true); select/date -> change(n, v, false); number ->
     change(n, v, true, (v) => { const c = toCents(v); return c == null ? "" : String(c); })
     (toCents aus @/lib/editor/parse wirft nicht, liefert null); combo -> <input list={id}> +
     <datalist>, exakter Label-Treffer liefert dessen `value` (Id), sonst "". Abschluss:
     <button type="submit" className="sr-only">Filtern</button> und der Zuruecksetzen-Link
     als echtes <a href={basePath}> (voller Neuaufbau leert `local`). */
}
```

- [ ] **Step 5: Gate + Commit** — Prüfkette **plus** `npm run api:check -- --write && npm run api:check`, dann:
```bash
git add src/components/list/FilterBar.tsx src/schemas/index.ts src/domain/document/list.ts src/domain/document/neighbors.ts openapi/openapi.json test/unit/list-filter-keys.test.ts
git commit -s -m "feat(listen): Filterleiste ohne Knopf, Betrags- und Kontaktfeld (Phase 13a, Task 6)"
```

### Task 7: Zeilenaktionen — eine Aktionsmatrix

**Files:** Create `src/components/list/RowPaymentDialog.tsx` · Modify `src/domain/document/actions.ts`, `src/components/list/RowActionsMenu.tsx`, `src/app/dokumente/[id]/page.tsx:48-51,130-136`, `test/unit/document-actions.test.ts`

**Ruling (Abweichung von der Spec, begründet):** Die Spec nennt fünf neue `ActionKey`s; drei davon existieren bereits oder wären eine dritte Matrix.
- `DELIVERY_NOTE_CREATE` **entfällt** — `DELIVERY_NOTE` gibt es seit Phase 8b (`actions.ts:56`).
- `QUOTE_ACCEPT`/`QUOTE_REJECT` **entfallen als Keys**: die Übergangstabelle steht bereits zweimal (`domain/document/status.ts:33` `QUOTE_TRANSITIONS`, clientseitig `components/DocumentActions.tsx:12` `QUOTE_ACTIONS`); ein dritter Ort wäre die verbotene Doppelung. `RowActionsMenu` rendert stattdessen die **bestehende** Komponente `DocumentActionsMenuItems` (`src/components/DocumentActionsMenu.tsx`) — inklusive Notiz-Dialog, Archivieren und Statuswechsel.
- `TEMPLATE_SAVE` **verschiebt sich nach 13d**, zusammen mit der Domain; ein Menüpunkt ohne Backend wäre eine Attrappe (DoD).
Neu ist damit genau **ein** Key: `CONVERT` — und er löst die vier lokalen Status-Sets der Dokument-Detailseite (`dokumente/[id]/page.tsx:48-51`) ab.

**Interfaces:** `ActionKey` bekommt `"CONVERT"`; neu `convertTargets(doc: ActionableDoc & { convertedToInvoiceId?: string | null; billingFull?: boolean }): { orderConfirmation: boolean; invoice: boolean; deliveryNote: boolean }`

- [ ] **Step 1: Failing test schreiben** — `test/unit/document-actions.test.ts` erweitern:

```ts
const quote = (status: string, extra = {}) => ({ kind: "QUOTE" as const, type: "ANGEBOT", status, isDraft: status === "DRAFT", ...extra });
it("Angebot: AB, Rechnung und Lieferschein in DRAFT/SENT/ACCEPTED/EXPIRED", () => {
  for (const s of ["DRAFT", "SENT", "ACCEPTED", "EXPIRED"]) {
    expect(convertTargets(quote(s))).toEqual({ orderConfirmation: true, invoice: true, deliveryNote: true });
    expect(availableActions(quote(s))).toContain("CONVERT");
  }
});
it("umgewandelt / vollstaendig berechnet / AB / PROFORMA / storniert", () => {
  expect(convertTargets(quote("SENT", { convertedToInvoiceId: "inv1" })).orderConfirmation).toBe(false);
  expect(convertTargets(quote("ACCEPTED", { billingFull: true }))).toEqual({ orderConfirmation: true, invoice: false, deliveryNote: false });
  expect(convertTargets({ ...quote("ACCEPTED"), type: "AUFTRAGSBESTAETIGUNG" }).invoice).toBe(false);
  expect(convertTargets({ ...quote("SENT"), type: "PROFORMA" }).deliveryNote).toBe(false);
  expect(availableActions(quote("CANCELLED"))).not.toContain("CONVERT");
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/document-actions.test.ts`.

- [ ] **Step 3: `convertTargets` schreiben** — die vier Sets aus `dokumente/[id]/page.tsx:48-51` **wortgleich** als Modulkonstanten nach `src/domain/document/actions.ts` verschieben und in `convertTargets` zusammenführen; `availableActions` hängt `CONVERT` an, sobald ein Ziel `true` ist. Die Detailseite importiert `convertTargets` und reicht dessen Felder an `ConvertMenu` (`showToOrderConfirmation`/`showToInvoice`/`showToDeliveryNote`); die lokalen Sets dort werden **gelöscht**. `showPartialInvoice`/`showDownpaymentInvoice`/`showFinalInvoice` bleiben unverändert an der Detailseite (sie hängen an `billing.billedPermille`/`hasActiveFinal`, nicht an der Sichtbarkeitsmatrix).

- [ ] **Step 4: `RowActionsMenu` ergänzen**
  - **Direktknöpfe vor dem `⋯`-Menü:** „PDF" (`<a href={pdfHref} target="_blank">`, nur bei `has("PDF")`) und „Zahlung" (öffnet `RowPaymentDialog`, nur bei `has("PAYMENT") && payment`). Beide bleiben **zusätzlich** im Menü, damit sich die Tastaturbedienung nicht ändert.
  - **`RowPaymentDialog`** (neu, ~40 Zeilen): nativer `<dialog className="w-full max-w-md …">` um das **bestehende** `PaymentForm` (`invoiceId`, `openCents`, `methods`, `defaultMethod`) — dieselbe Server-Action, nur anderer Rahmen. Zentrierung kommt aus der globalen Regel `dialog:modal { margin: auto }` (Phase 12a, `globals.css`), nicht neu gebaut; 13c verwendet denselben Rahmen für die Belegseite wieder.
  - **`CONVERT`:** neue optionale Prop `convert?: ConvertTargets` ⇒ `<ConvertMenu sourceType="QUOTE" sourceId={id} showToOrderConfirmation={convert.orderConfirmation} showToInvoice={convert.invoice} showToDeliveryNote={convert.deliveryNote} asMenuItem />`.
  - **Statuswechsel:** neue optionale Prop `documentActions?: { type: "QUOTE" | "DELIVERY_NOTE"; status: string; archived: boolean }` ⇒ rendert `<DocumentActionsMenuItems …/>`. Keine eigene Logik.

- [ ] **Step 5: Gate + Commit** — Prüfkette, dann:
```bash
git add src/domain/document/actions.ts src/components/list src/app/dokumente test/unit/document-actions.test.ts
git commit -s -m "feat(listen): Zeilenaktionen ueber eine Aktionsmatrix, Direktknoepfe PDF und Zahlung (Phase 13a, Task 7)"
```

### Task 8: Seiten verdrahten, Doku, Smoke, Gesamtprüfung

*(letzter Task der Teilphase — kein eigenes Task-Review, Abnahme im Abschluss-Review)*

**Files:** `src/app/{rechnungen,dokumente,lieferscheine,abos}/page.tsx`, `docs/{ANLEITUNG,LIMITATIONEN,ARCHITEKTUR}.md`

- [ ] **Step 1: `/rechnungen`** — `values` um `customerId`, `minCents`, `maxCents`, `paymentMethodId`, `eInvoice` erweitern (alle fünf gehören auch in `buildListeParam`); `StatusTabs` mit `invoiceStatusTabCounts` über die Filterwerte **ohne** `status`; `ListHeadline` mit `invoiceListHeadline` (Belege · Brutto gesamt · Offen · Überfällig, letzte Kachel `tone: "danger"`, bei `mixedCurrency` Hinweis „gemischte Währungen"); Summenzeile Z. 90-95 und Status-Select aus `fields` **entfallen**; Spalte „Fällig" zeigt `relativeDueLabel(inv.dueDate, now).text` mit `title={deDate(inv.dueDate)}` und roter Schrift bei `overdue`; unter der Nummer die Herkunft aus `originsFor(org.id, "INVOICE", ids)` als kleiner Link. Liste, Tabs und Kennzahlen laufen in **einem** `Promise.all`.
- [ ] **Step 2: `/dokumente`** — Tabs `all` + `QuoteStatus` + (wenn `billingStateIndex().available`) `billed`/`partially-billed`; `ListHeadline` mit Anzahl + Σ Brutto (`groupBy` analog, ohne offen/überfällig); Filterfelder Suche, Kontakt (`combo`), Art, Von/Bis; Zeilen-Chip `BillingStateBadge` aus dem Index; `RowActionsMenu` bekommt `convert` und `documentActions`.
- [ ] **Step 3: `/lieferscheine` und `/abos`** — Tabs statt Status-Select (`deliveryNoteStatusTabCounts` bzw. `recurringStatusTabCounts`), Kontaktfeld, Herkunft je Lieferscheinzeile (`originsFor(org.id, "DELIVERY_NOTE", ids)`); `/abos` behält seinen übrigen Aufbau.
- [ ] **Step 4: Doku** (Code schlägt Doku — jede Formulierung gegen die Implementierung prüfen)
  - `ANLEITUNG.md`, Abschnitt Listen: Status-Tabs, Sofortfilter ohne Knopf, Kopfkennzahlen („beziehen sich auf die **gefilterte** Menge, nicht auf die angezeigte Seite"), relative Fälligkeit, Herkunft. `ARCHITEKTUR.md`: `invoiceFilterConditions`/`invoiceStatusTabCounts`/`invoiceListHeadline`, `deriveBillingState`/`billingStateIndex`, `originsFor`, `relativeDueLabel` in die Modulübersicht.
  - `LIMITATIONEN.md`, neuer Absatz „Listen (Phase 13a)": (1) Tabs „Berechnet"/„Teilberechnet" entfallen ab 20 000 Belegverknüpfungen je Organisation — lieber kein Tab als eine falsche Zahl. (2) Die Status-Tabs überlappen sich dort, wo es die Statuslogik tut: eine teilbezahlte Rechnung mit Restbetrag erscheint unter „Teilbezahlt" **und** unter „Offen/Fällig/Überfällig". (3) Kennzahlen über mehrere Währungen werden als Summe mit Hinweis gezeigt, nicht umgerechnet. (4) Die Filterleiste navigiert per JavaScript; ohne JavaScript filtert sie weiterhin per Enter/Absenden.
- [ ] **Step 5: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots einzeln nach `<scratchpad>/ui-previews/13a-*.png`):
  (1) `/rechnungen`: Tab „Überfällig" → filtert **ohne** Knopf, `aria-current="page"` sitzt am Tab, Zeilenzahl = Zahl am Tab. (2) Suchfeld tippen → nach ~300 ms neue URL, keine Doppelnavigation (Netzwerkpanel), Cursor bleibt im Feld. (3) Betrag „von 100" → `?minCents=10000`; Detailseite öffnen → „Zurück zur Liste" behält Filter und Tab. (4) `/dokumente`: Tab „Berechnet" zeigt nur vollständig berechnete Angebote; Zeilenmenü zeigt „Annehmen" und „Rechnung erzeugen". (5) Breite: Liste nutzt die volle Fensterbreite, `/einstellungen/marke` bleibt schmal.
  Konsolenfehler protokollieren; kein CI-Gate.
- [ ] **Step 6: Gesamtprüfung** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check` (Vordergrund, Timeout 600000 ms). `scripts/test-postgres-migrations.sh` **nicht** nötig: Phase 13a ändert kein Schema.
- [ ] **Step 7: Commit**
```bash
git add src/app docs && git commit -s -m "feat(listen): Tabs, Kennzahlen, Herkunft und Faelligkeit in allen vier Listen (Phase 13a, Task 8)"
```

## Abschluss-Review (opus) — Prüfpunkte

1. **Nur lesen:** `git diff main --stat -- prisma/` leer; kein neuer `create/update/delete`-Aufruf im Diff; `src/lib/db.ts` unverändert.
2. **Ein Statusbegriff:** `grep -n "statusWhere\|quoteStatusWhere" src/domain` — je eine Definition, genutzt von Liste **und** Zählern; für jeden Tab gilt `count === list.total` (Task-3-Test).
3. **Geld:** `invoiceListHeadline` nutzt `openAmountCents` + `effectiveInvoiceStatus`, keine eigene Formel; `openCents` nie negativ; Summen über die gefilterte Menge; Währungsmischung ausgewiesen.
4. **Äquivalenz:** `billingStateIndex` und `billingStateFor` liefern über die zehn Konstellationen identische Zustände, beide über `deriveBillingState`; die Mengenbedingung ist wörtlich die aus `billedQuantities`; die Obergrenze 20 000 blendet die zwei Tabs aus statt zu raten.
5. **Kein N+1:** feste Abfragezahl je Seite (`originsFor` ≤ 6, `billingStateIndex` ≤ 5, Tabs = Tabzahl, Kennzahlen 2) — im Diff nachzählen, kein `await` in einer `map` über Zeilen.
6. **Eine Aktionsmatrix (§41):** `grep -rn "ANGEBOT_TO_AB_STATUSES\|QUOTE_TO_DELIVERY_NOTE_STATUSES" src/app` leer; `convertTargets` ist die einzige Quelle; kein `TEMPLATE_SAVE` ohne Backend; `DocumentActionsMenuItems` statt einer dritten Übergangstabelle.
7. **Filter vollständig:** jeder angebotene Filter steht in `ALLOWED_KEYS` **und** im Zod-Schema (Task-6-Test); `tag` erscheint in keiner Leiste, bis 13d es auswertet.
8. **Zeit und Schnittstellen:** alle Tagesvergleiche über `utcDateOnly`, `TZ=Europe/Berlin npx vitest run test/unit/relative-date.test.ts` grün; `npm run api:check` grün und `openapi/openapi.json` enthält die neuen Quote-/DeliveryNote-Filterfelder; MCP unverändert.
9. **Smoke:** Screenshots zeigen Tabs mit stimmigen Zählern, Sofortfilter, volle Breite bei Listen und schmale Einstellungsseiten. Betreiberfrage: „Sind Tabs, Kennzahlen, Fälligkeit und Herkunft so, wie du sie erwartest?"
