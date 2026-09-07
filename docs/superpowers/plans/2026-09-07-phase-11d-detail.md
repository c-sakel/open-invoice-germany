# Phase 11d — Belegansicht (DocumentDetailLayout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die drei Belegdetailseiten (`/rechnungen/[id]`, `/dokumente/[id]`, `/lieferscheine/[id]`) auf eine gemeinsame, PDF-zentrierte Ansicht nach sevDesk-Vorbild umstellen: Kopfzeile mit Aktionen und „Mehr“-Menü, PDF-Seitenstapel in der Mitte, Statuskarte rechts, Verlauf/Positionen unten, Pfeile zum vorherigen/nächsten Beleg innerhalb der aktuellen Liste.

**Architecture:** Eine Server-Komponente `DocumentDetailLayout` (Slots: `header`, `pdf`, `aside`, `children`) plus kleine Bausteine (`PdfStack`, `StatusCard`, `ActionMenu`, `DetailNav`) in `src/components/detail/`. Die Seiten behalten ihre gesamte Fachlogik (Mahnplan, Abzüge, Aktionsmatrix, Statusübergänge) und liefern sie nur in die Slots; große Seiten werden in `_parts/`-Dateien zerlegt. Vor/Zurück-Navigation über eine reine Domain-Funktion `neighborIds` und einen Query-Parameter `liste=<Listen-Query>` (der Name `from` ist als Datumsfilter der Listen bereits belegt).

**Tech Stack:** Next.js App Router (Server Components, `<details>`-Menüs ohne Client-JS), Tailwind, bestehende Domain-Listenfunktionen (`listInvoices`, `listQuotes`, `listDeliveryNotes`), Zod, Vitest, Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md` (Zeile „Belegansicht“ in Abschnitt 2, Struktur in Abschnitt 3, Tests in Abschnitt 4, Teilphase 4 in Abschnitt 5). Offene 11a-Punkte mit Zielphase 11d: Ledger `docs/superpowers/ledgers/2026-09-07-phase-11a-shell.md` Abschnitt „Offen / spaeter“.

## Global Constraints

- Branch `phase-11d/detail` aus Fork-`main` (2047bd3 oder neuer). Jeder Commit `git commit -s`.
- Keine neue Abhängigkeit. Kein pdf.js: PDF-Darstellung bleibt der Browser-PDF-Viewer im `iframe` (Spec: „bestehender PdfPreview, Seitenhöhe = Breite·√2, Fallback Download-Link“).
- GoBD: die Seiten rufen weiterhin ausschließlich die bestehenden Server-Actions/Routen (`finalizeAction`, `cancelAction`, `/api/*/status`, `/api/*/duplicate`, ConvertMenu). Keine neuen Schreibpfade. `internalNotes` bleiben sichtbar markiert „nur intern“ und stehen nie im PDF.
- Prisma immer mit `select`/`include`; bestehende `findFirst({ where: { id, orgId } })`-Mandantenprüfungen bleiben unverändert.
- Zod an der Boundary: der Query-Parameter `liste` wird über `listeQuerySchema` (Task 1) geparst; ungültige Werte ⇒ keine Pfeile, keine Fehlerseite.
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen (Seiten in `_parts/` zerlegen). Deutsche UI-Texte mit echten Umlauten wie in den bestehenden Seiten.
- Nichts doppelt bauen: `StatusBadge`, `BillingStateBadge`, `PaymentForm`, `DunningActions`, `DocumentChain`, `DocumentTimeline`, `EmailHistory`, `LineItemsTable`, `AttachmentPanel`, `ConvertMenu`, `SendEmailDialog`, `DocumentActions`, `DuplicateInvoiceButton`, `PrintOptionsPanel`, `ShareLinkPanel` werden wiederverwendet, nicht kopiert.
- `PdfPreview.tsx` wird durch `PdfStack` ersetzt (einziger Nutzer sind die drei Detailseiten — `grep -rn PdfPreview src/` muss danach leer sein) — Regel „Code schlägt Doku“: ARCHITEKTUR.md nachziehen.
- Alle bisherigen Tests bleiben grün (`TZ=UTC npm test`), dazu `npm run typecheck`, `npm run lint`, `npm run build`, `npm run validate:erechnung`, `npm run api:check`.
- Editor/Detail ohne Komponententests (kein RTL im Projekt): Playwright-Smoke im letzten Task, nicht als CI-Gate.

---

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/domain/document/neighbors.ts` | `neighborIds` (rein), `listeQuerySchema`, `parseListeQuery`, `loadNeighbors(kind, orgId, liste)` — Vor/Zurück innerhalb der Liste |
| `src/components/detail/DocumentDetailLayout.tsx` | Rahmen: Kopf, zweispaltiger Bereich (PDF | Aside), Unten |
| `src/components/detail/DetailNav.tsx` | Zurück-Link + Pfeile vorheriger/nächster (Client: Alt+←/→) |
| `src/components/detail/PdfStack.tsx` | iframe im A4-Verhältnis, Download-Fallback, „Noch kein PDF“ für Entwürfe ohne Nummer |
| `src/components/detail/StatusCard.tsx` | Statuskarte: Badges, Zeilen (`label`/`value`), Kunde mit Link |
| `src/components/detail/ActionMenu.tsx` | „Mehr“-Menü als `<details>`, nimmt Links/Forms als Kinder |
| `src/components/detail/CollapsibleSection.tsx` | `<details>` mit Titel („Positionen anzeigen“, „Zahlung erfassen“) |
| `src/components/shell/NavHint.tsx` + `ShellProvider.tsx` | Detailseiten melden der Sidebar den passenden Listen-Link (11a-M12) |
| `src/app/rechnungen/[id]/page.tsx` + `_parts/*.tsx` | Rechnungsansicht auf dem Layout |
| `src/app/dokumente/[id]/page.tsx` + `_parts/*.tsx` | Angebot/AB/Proforma auf dem Layout |
| `src/app/lieferscheine/[id]/page.tsx` + `_parts/*.tsx` | Lieferschein auf dem Layout |
| `src/app/{rechnungen,dokumente,lieferscheine}/page.tsx` | Zeilen-Links tragen `?liste=` |
| `test/unit/document-neighbors.test.ts`, `test/unit/nav.test.ts` | Tests |
| `docs/ARCHITEKTUR.md`, `docs/ANLEITUNG.md`, `docs/LIMITATIONEN.md`, `README.md` | Doku |

---

### Task 1: Nachbarn in der Liste (`neighbors.ts`) und `?liste=` in den Listen

**Files:**
- Create: `src/domain/document/neighbors.ts`
- Modify: `src/app/rechnungen/page.tsx:166` (Zeilen-Link), `src/app/dokumente/page.tsx:114`, `src/app/lieferscheine/page.tsx:102`
- Test: `test/unit/document-neighbors.test.ts`

**Interfaces:**
- Consumes: `listInvoices(orgId, rawFilter, now)` aus `@/domain/invoice/list`, `listQuotes(orgId, rawFilter, now)` und `listDeliveryNotes(orgId, rawFilter)` aus `@/domain/document/list`, `parseListQuery` aus `@/lib/list-query`.
- Produces:
  ```ts
  export type NeighborKind = "INVOICE" | "QUOTE" | "DELIVERY_NOTE";
  export interface Neighbors { prevId: string | null; nextId: string | null; backQuery: string }
  export function neighborIds(ids: readonly string[], currentId: string): { prevId: string | null; nextId: string | null };
  export const listeQuerySchema: z.ZodString; // max 500 Zeichen, nur [A-Za-z0-9=&%._-]
  export function parseListeQuery(liste: string | undefined): URLSearchParams | null;
  export function buildListeParam(values: Record<string, string | undefined>): string; // fuer die Listen
  export async function loadNeighbors(kind: NeighborKind, orgId: string, id: string, liste: string | undefined): Promise<Neighbors>;
  ```

- [ ] **Step 1: Failing tests schreiben**

```ts
// test/unit/document-neighbors.test.ts
import { describe, it, expect } from "vitest";
import { neighborIds, parseListeQuery, buildListeParam } from "@/domain/document/neighbors";

describe("neighborIds", () => {
  it("liefert Vorgaenger/Nachfolger in Listenreihenfolge (neuester zuerst)", () => {
    expect(neighborIds(["c", "b", "a"], "b")).toEqual({ prevId: "c", nextId: "a" });
  });
  it("Randfaelle: erster/letzter/unbekannt/leer", () => {
    expect(neighborIds(["c", "b", "a"], "c")).toEqual({ prevId: null, nextId: "b" });
    expect(neighborIds(["c", "b", "a"], "a")).toEqual({ prevId: "b", nextId: null });
    expect(neighborIds(["c", "b", "a"], "x")).toEqual({ prevId: null, nextId: null });
    expect(neighborIds([], "x")).toEqual({ prevId: null, nextId: null });
  });
});

describe("parseListeQuery", () => {
  it("akzeptiert eine Listen-Query und verwirft unbekannte Schluessel", () => {
    const p = parseListeQuery("status=open&q=Meier&type=INVOICE&offset=50&evil=1")!;
    expect(p.get("status")).toBe("open");
    expect(p.get("q")).toBe("Meier");
    expect(p.get("offset")).toBe("50");
    expect(p.has("evil")).toBe(false);
  });
  it("lehnt Leerwert, Ueberlaenge und fremde Zeichen ab", () => {
    expect(parseListeQuery(undefined)).toBeNull();
    expect(parseListeQuery("")).toBeNull();
    expect(parseListeQuery("q=" + "a".repeat(600))).toBeNull();
    expect(parseListeQuery("q=<script>")).toBeNull();
  });
  it("buildListeParam laesst leere Werte weg und ist per parseListeQuery lesbar", () => {
    const s = buildListeParam({ q: "Meier", status: undefined, kind: "ANGEBOT", offset: "" });
    expect(s).toBe("q=Meier&kind=ANGEBOT");
    expect(parseListeQuery(s)!.get("kind")).toBe("ANGEBOT");
  });
});
```

- [ ] **Step 2: Test laufen lassen (rot)**

Run: `TZ=UTC npx vitest run test/unit/document-neighbors.test.ts`
Expected: FAIL — Modul nicht gefunden.

- [ ] **Step 3: Implementieren**

```ts
// src/domain/document/neighbors.ts
/**
 * Vor/Zurueck innerhalb der aktuellen Liste (Phase 11d). Die Listen haengen ihre
 * Filter-Query als `?liste=<query>` an jeden Zeilen-Link; die Detailseite laedt mit
 * demselben Filter (ohne Paginierung, max. 200 Zeilen) die Id-Reihenfolge und sucht die
 * Nachbarn. `from` ist als Datumsfilter der Listen belegt, daher der Name `liste`.
 */
import { z } from "zod";
import { listInvoices } from "@/domain/invoice/list";
import { listQuotes, listDeliveryNotes } from "@/domain/document/list";
import { parseListQuery } from "@/lib/list-query";

export type NeighborKind = "INVOICE" | "QUOTE" | "DELIVERY_NOTE";

export interface Neighbors {
  prevId: string | null;
  nextId: string | null;
  /** Bereinigte Query fuer den Zurueck-Link (ohne fuehrendes `?`, ggf. leer). */
  backQuery: string;
}

/** Schluessel, die die drei Listen kennen (FilterBar + Pagination + Archiv-Schalter). */
const ALLOWED_KEYS = new Set(["q", "status", "type", "kind", "from", "to", "offset", "archiviert", "customerId"]);
/** Maximal 200 Zeilen je Listenabfrage (Schema-Maximum der Listenfilter). */
const NEIGHBOR_LIMIT = 200;

export const listeQuerySchema = z.string().min(1).max(500).regex(/^[A-Za-z0-9=&%._+-]*$/);

export function neighborIds(ids: readonly string[], currentId: string): { prevId: string | null; nextId: string | null } {
  const i = ids.indexOf(currentId);
  if (i < 0) return { prevId: null, nextId: null };
  return { prevId: i > 0 ? ids[i - 1] : null, nextId: i < ids.length - 1 ? ids[i + 1] : null };
}

export function parseListeQuery(liste: string | undefined): URLSearchParams | null {
  const parsed = listeQuerySchema.safeParse(liste);
  if (!parsed.success) return null;
  const raw = new URLSearchParams(parsed.data);
  const out = new URLSearchParams();
  for (const [k, v] of raw) if (ALLOWED_KEYS.has(k) && v !== "") out.set(k, v);
  return out;
}

export function buildListeParam(values: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (ALLOWED_KEYS.has(k) && v) p.set(k, v);
  return p.toString();
}

async function orderedIds(kind: NeighborKind, orgId: string, params: URLSearchParams): Promise<string[]> {
  const raw = parseListQuery(params);
  delete raw.offset;
  delete raw.archiviert;
  const includeArchived = params.get("archiviert") === "1";
  const filter = { ...raw, limit: NEIGHBOR_LIMIT, offset: 0 };
  try {
    if (kind === "INVOICE") return (await listInvoices(orgId, filter)).rows.map((r) => r.id);
    if (kind === "QUOTE") return (await listQuotes(orgId, { ...filter, includeArchived })).rows.map((r) => r.id);
    return (await listDeliveryNotes(orgId, { ...filter, includeArchived })).rows.map((r) => r.id);
  } catch (e) {
    if (e instanceof z.ZodError) return [];
    throw e;
  }
}

export async function loadNeighbors(kind: NeighborKind, orgId: string, id: string, liste: string | undefined): Promise<Neighbors> {
  const params = parseListeQuery(liste);
  if (!params) return { prevId: null, nextId: null, backQuery: "" };
  const ids = await orderedIds(kind, orgId, params);
  return { ...neighborIds(ids, id), backQuery: params.toString() };
}
```

Prüfen: `invoiceListFilterSchema` (`src/schemas/index.ts` ~Z. 566) und die Quote-/Lieferschein-Filter erlauben `limit` bis 200 — sonst `NEIGHBOR_LIMIT` auf das Schema-Maximum setzen. `listQuotes`/`listDeliveryNotes` erwarten `includeArchived` als boolean (siehe `quoteListFilterSchema`); `parseListQuery` liefert Strings, daher wird `archiviert` oben entfernt und als boolean übergeben.

- [ ] **Step 4: Tests grün**

Run: `TZ=UTC npx vitest run test/unit/document-neighbors.test.ts`
Expected: PASS (6 Tests).

- [ ] **Step 5: Zeilen-Links der drei Listen ergänzen**

In `src/app/rechnungen/page.tsx` (`values` existiert bereits, Z. 51–58):
```tsx
import { buildListeParam } from "@/domain/document/neighbors";
// ...
const liste = buildListeParam(values);
const detailHref = (id: string) => `/rechnungen/${id}${liste ? `?liste=${encodeURIComponent(liste)}` : ""}`;
// Zeile 166:
<Link href={detailHref(inv.id)} className="font-medium text-indigo-600 hover:underline">
```
Gleiches Muster in `src/app/dokumente/page.tsx` (Basis `/dokumente/`, `values` enthält `kind` und `archiviert`) und `src/app/lieferscheine/page.tsx` (Basis `/lieferscheine/`). `RowActionsMenu`-Links („Öffnen“) bleiben unverändert (ohne `liste`).

- [ ] **Step 6: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test`
```bash
git add src/domain/document/neighbors.ts test/unit/document-neighbors.test.ts src/app/rechnungen/page.tsx src/app/dokumente/page.tsx src/app/lieferscheine/page.tsx
git commit -s -m "feat(detail): Nachbarn in der aktuellen Liste, ?liste= an Zeilen-Links (Phase 11d, Task 1)"
```

---

### Task 2: Detail-Bausteine (`src/components/detail/*`) und `NavHint`

**Files:**
- Create: `src/components/detail/DocumentDetailLayout.tsx`, `DetailNav.tsx`, `PdfStack.tsx`, `StatusCard.tsx`, `ActionMenu.tsx`, `CollapsibleSection.tsx`, `src/components/shell/NavHint.tsx`
- Modify: `src/components/shell/ShellProvider.tsx`, `src/components/shell/Sidebar.tsx:25-27`
- Test: `test/unit/nav.test.ts` (Hint-Fall)

**Interfaces:**
- Produces:
  ```tsx
  // DocumentDetailLayout
  interface Props { nav: ReactNode; title: string; badges?: ReactNode; actions?: ReactNode; more?: ReactNode; notice?: ReactNode; pdf: ReactNode; aside: ReactNode; children?: ReactNode }
  // DetailNav (Client)
  interface Props { backHref: string; backLabel: string; prevHref: string | null; nextHref: string | null }
  // PdfStack
  interface Props { src: string | null; title: string; downloadHref?: string; emptyText?: string }
  // StatusCard
  interface Row { label: string; value: ReactNode }
  interface Props { title?: string; status: ReactNode; rows: Row[]; children?: ReactNode }
  // ActionMenu
  interface Props { label?: string; children: ReactNode }  // Kinder: <ActionMenuItem>
  export function ActionMenuItem({ children }: { children: ReactNode })  // li-Wrapper mit Hover-Klassen
  // CollapsibleSection
  interface Props { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }
  // NavHint (Client): meldet der Sidebar, welcher Listen-Link aktiv markiert wird
  export function NavHint({ href }: { href: string })
  ```
- `ShellProvider` erhält `navHint: string | null`, `setNavHint(href: string | null)`.

- [ ] **Step 1: `nav.test.ts` um den Hint-Fall erweitern (rot)**

```ts
it("Hint einer Detailseite ueberstimmt Pfad/Query (11a-M12: /dokumente/<id> als AB)", () => {
  const verkauf = NAV_GROUPS.find((g) => g.key === "verkauf")!;
  const ab = verkauf.items.find((i) => i.label === "Auftragsbestätigungen")!;
  const angebote = verkauf.items.find((i) => i.label === "Angebote")!;
  expect(itemMatches(ab, "/dokumente", "?kind=AUFTRAGSBESTAETIGUNG")).toBe(true);
  expect(itemMatches(angebote, "/dokumente", "?kind=AUFTRAGSBESTAETIGUNG")).toBe(false);
});
```
(Der Hint wird in der Sidebar in `pathname`/`search` übersetzt; `itemMatches` selbst bleibt unverändert — der Test dokumentiert das Zielverhalten.)

- [ ] **Step 2: `ShellProvider` + `NavHint` + Sidebar**

```tsx
// ShellProvider.tsx — Kontext erweitern
interface ShellContextValue {
  searchOpen: boolean; openSearch: () => void; closeSearch: () => void;
  navHint: string | null; setNavHint: (href: string | null) => void;
}
// im Provider:
const [navHint, setNavHint] = useState<string | null>(null);
// value um navHint/setNavHint ergaenzen (useMemo-Deps!)
```
```tsx
// src/components/shell/NavHint.tsx
"use client";
import { useEffect } from "react";
import { useShell } from "./ShellProvider";
/** Detailseiten ohne eigenen Listen-Pfad (z. B. /dokumente/<id> einer AB) melden der
 *  Sidebar den Listen-Link, der als aktiv gelten soll (11a-M12). Rendert nichts. */
export function NavHint({ href }: { href: string }) {
  const { setNavHint } = useShell();
  useEffect(() => {
    setNavHint(href);
    return () => setNavHint(null);
  }, [href, setNavHint]);
  return null;
}
```
```tsx
// Sidebar.tsx Z. 25-27
const { navHint } = useShell();
const routePathname = usePathname();
const routeSearch = useSearchParams().toString();
const [hintPath, hintQuery = ""] = (navHint ?? "").split("?");
const pathname = navHint ? hintPath : routePathname;
const searchStr = navHint ? (hintQuery ? `?${hintQuery}` : "") : routeSearch ? `?${routeSearch}` : "";
```
`Sidebar` wird bereits innerhalb von `ShellProvider` gerendert (AppShell) — `useShell()` ist dort erlaubt. Die Drawer-Sidebar (Topbar) ebenfalls.

- [ ] **Step 3: Bausteine schreiben**

```tsx
// src/components/detail/DetailNav.tsx
"use client";
import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Zurueck-Link + Pfeile zum vorherigen/naechsten Beleg der aktuellen Liste.
 *  Tastatur: Alt+Pfeil links/rechts (nicht in Eingabefeldern). */
export function DetailNav({ backHref, backLabel, prevHref, nextHref }: { backHref: string; backLabel: string; prevHref: string | null; nextHref: string | null }) {
  const router = useRouter();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft" && prevHref) { e.preventDefault(); router.push(prevHref); }
      if (e.key === "ArrowRight" && nextHref) { e.preventDefault(); router.push(nextHref); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prevHref, nextHref, router]);
  const arrow = "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 aria-disabled:opacity-40 aria-disabled:pointer-events-none";
  return (
    <div className="flex items-center gap-2">
      <Link href={backHref} className="text-sm text-slate-500 hover:text-slate-800">← {backLabel}</Link>
      <span className="ml-2 inline-flex gap-1">
        <Link href={prevHref ?? "#"} aria-disabled={!prevHref} aria-label="Vorheriger Beleg" title="Vorheriger Beleg (Alt+←)" className={arrow}>‹</Link>
        <Link href={nextHref ?? "#"} aria-disabled={!nextHref} aria-label="Nächster Beleg" title="Nächster Beleg (Alt+→)" className={arrow}>›</Link>
      </span>
    </div>
  );
}
```
```tsx
// src/components/detail/PdfStack.tsx
/** PDF-Ansicht in der Seitenmitte (Phase 11d): Browser-PDF-Viewer im iframe im A4-Verhaeltnis
 *  (Hoehe = Breite * sqrt 2, per CSS aspect-ratio), darunter ein Download-Link als Fallback fuer
 *  Browser ohne eingebetteten Viewer. Ohne `src` (Entwurf ohne Nummer/PDF) ein Hinweis. */
export function PdfStack({ src, title, downloadHref, emptyText }: { src: string | null; title: string; downloadHref?: string; emptyText?: string }) {
  if (!src) {
    return <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">{emptyText ?? "Noch kein PDF verfügbar."}</div>;
  }
  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 shadow-sm">
        <iframe src={`${src}#toolbar=0&navpanes=0`} title={title} className="block w-full" style={{ aspectRatio: "1 / 1.4142" }} />
      </div>
      <p className="text-right text-xs text-slate-500">
        Wird das PDF nicht angezeigt: <a href={downloadHref ?? src} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">PDF öffnen</a>
      </p>
    </div>
  );
}
```
```tsx
// src/components/detail/StatusCard.tsx
import type { ReactNode } from "react";
export interface StatusRow { label: string; value: ReactNode }
export function StatusCard({ title = "Status", status, rows, children }: { title?: string; status: ReactNode; rows: StatusRow[]; children?: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">{title}</h2>
        <div className="flex flex-wrap items-center gap-1">{status}</div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-slate-500">{r.label}</dt>
            <dd className="text-right text-slate-800">{r.value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}
```
```tsx
// src/components/detail/ActionMenu.tsx
import type { ReactNode } from "react";
/** "Mehr"-Menue ohne Client-JS: <details> mit absolut positionierter Liste. Kinder sind
 *  <ActionMenuItem> mit Link, Button oder <form action=...> (Server Actions bleiben nutzbar). */
export function ActionMenu({ label = "Mehr", children }: { label?: string; children: ReactNode }) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 [&::-webkit-details-marker]:hidden">{label} ▾</summary>
      <ul className="absolute right-0 z-20 mt-1 min-w-56 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">{children}</ul>
    </details>
  );
}
export function ActionMenuItem({ children }: { children: ReactNode }) {
  return <li className="[&>a,&>button,&>form>button]:block [&>a,&>button,&>form>button]:w-full [&>a,&>button,&>form>button]:px-3 [&>a,&>button,&>form>button]:py-1.5 [&>a,&>button,&>form>button]:text-left [&>a,&>button,&>form>button]:hover:bg-slate-50">{children}</li>;
}
export function ActionMenuSeparator() { return <li className="my-1 border-t border-slate-100" />; }
```
```tsx
// src/components/detail/CollapsibleSection.tsx
import type { ReactNode } from "react";
export function CollapsibleSection({ title, summary, defaultOpen = false, children }: { title: string; summary?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-slate-900">
        <span>{title}</span>
        {summary && <span className="font-normal text-slate-500">{summary}</span>}
      </summary>
      <div className="border-t border-slate-100 p-4">{children}</div>
    </details>
  );
}
```
```tsx
// src/components/detail/DocumentDetailLayout.tsx
import type { ReactNode } from "react";
/** Gemeinsamer Rahmen der Belegdetailseiten (Phase 11d): Kopf (Nav, Titel, Badges,
 *  Aktionen, Mehr-Menue), Hinweise, Mitte PDF | rechts Statuskarte, unten volle Breite. */
export function DocumentDetailLayout({ nav, title, badges, actions, more, notice, pdf, aside, children }: {
  nav: ReactNode; title: string; badges?: ReactNode; actions?: ReactNode; more?: ReactNode; notice?: ReactNode; pdf: ReactNode; aside: ReactNode; children?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {nav}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {badges}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {more}
          </div>
        </div>
      </div>
      {notice}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">{pdf}</div>
        <aside className="space-y-4">{aside}</aside>
      </div>
      {children && <div className="space-y-6">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npx vitest run test/unit/nav.test.ts`
```bash
git add src/components/detail src/components/shell/NavHint.tsx src/components/shell/ShellProvider.tsx src/components/shell/Sidebar.tsx test/unit/nav.test.ts
git commit -s -m "feat(detail): Layout-Bausteine, PdfStack, Statuskarte, Mehr-Menue, NavHint (Phase 11d, Task 2)"
```

---

### Task 3: Rechnungsansicht auf das Layout umstellen

**Files:**
- Modify: `src/app/rechnungen/[id]/page.tsx` (komplett neu aufgebaut, ≤ 250 Zeilen)
- Create: `src/app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx`, `_parts/InvoiceMoreMenu.tsx`, `_parts/InvoiceTotals.tsx`, `_parts/PaymentSection.tsx`, `_parts/CorrectionSection.tsx`, `_parts/invoice-view-model.ts`

**Interfaces:**
- Consumes: Task 1 `loadNeighbors("INVOICE", org.id, id, liste)`; Task 2 Bausteine.
- Produces: `_parts/invoice-view-model.ts` exportiert `buildInvoiceViewModel(invoice, org)` mit allen heute in der Seite berechneten Werten (`isDraft`, `isCancelled`, `actions`, `canCancelOrCredit`, `canDuplicate`, `breakdown`, `documentDiscountTotalCents`, `documentChargeTotalCents`, `hasSkonto`, `paymentMethodName`, `isInvoiceType`, `payableBase`, `openCents`, `dueDate`, `isOverdue`, `canPay`, `emailDocType`, `deductionsByInvoice`) — reine Funktion, kein DB-Zugriff; die DB-Zugriffe (Quelle, Mahnplan, Zahlungsmethoden, Anhänge) bleiben in der Seite.

- [ ] **Step 1: View-Model extrahieren** — die Berechnungen aus `page.tsx` Z. 87–175 unverändert nach `_parts/invoice-view-model.ts` verschieben (Typ des Prisma-Ergebnisses per `Prisma.InvoiceGetPayload<{ include: {...} }>` aus dem bestehenden `include` ableiten und als `InvoiceDetail` exportieren). Keine Logikänderung.

- [ ] **Step 2: Seite auf das Layout setzen**

Slots:
- `nav`: `<DetailNav backHref={`/rechnungen${backQuery ? `?${backQuery}` : ""}`} backLabel="Rechnungen" prevHref={prevId ? `/rechnungen/${prevId}?liste=…` : null} nextHref=… />` — `liste` unverändert weiterreichen (`encodeURIComponent(liste)`), `searchParams` erweitern um `liste?: string`.
- `title`: `${TYPE_TITLE[invoice.type] ?? "Beleg"} ${invoice.number ?? "(Entwurf)"}`.
- `badges`: `StatusBadge`, Quelle-Link („zu Angebot AN-…“), Migrations-Hinweis (wie heute).
- `actions`: `isDraft` ⇒ `Bearbeiten` (Link) + `Festschreiben` (Form `finalizeAction`, Primärknopf indigo); sonst `PDF` (Link) + `SendEmailDialog` + `PaymentSection`-Kurzform? Nein: Primäraktion je Status: DRAFT → Festschreiben; offen/überfällig (`canPay`) → Knopf „Zahlung erfassen“ als Link `#zahlung` (springt zur eingeklappten Zahlung in der Statuskarte, die per `defaultOpen={canPay}` bereits offen ist); bezahlt/storniert → keine Primäraktion.
- `more`: `<InvoiceMoreMenu …/>` mit: XRechnung (XML), ZUGFeRD (PDF) (beide nur `!isDraft`), Duplizieren (`DuplicateInvoiceButton`, nur wenn `canDuplicate`), Teilgutschrift (Link, `canCancelOrCredit`), Stornieren (Form `cancelAction`, `canCancelOrCredit`, rot), Lieferschein/Konvertieren (`ConvertMenu` wie heute bei `!isDraft && !isCancelled && isInvoiceType`), Druckoptionen (nur DRAFT: Link `#druckoptionen` — Rechnungen haben heute keinen `PrintOptionsPanel` auf der Detailseite, Layout wird im Editor unter „Weitere Optionen“ gewählt; Menüpunkt daher NICHT aufnehmen — Ruling: kein neuer Pfad).
- `notice`: `error`-Box und Entwurfs-Hinweis (wie heute).
- `pdf`: `<PdfStack src={`/api/invoices/${invoice.id}/pdf`} title=… />` — auch im Entwurf (die Route rendert Entwürfe, siehe heutiger PDF-Knopf, der auch im Entwurf sichtbar ist).
- `aside`: `<InvoiceStatusCard>` (Status-Badge + `überfällig`-Chip; Zeilen: Kunde (Link `/kunden/<id>`), Rechnungsdatum, Leistungsdatum, Fällig, Brutto, Bezahlt, Offen (fett), Steuerschema, Zahlungsmethode, Skonto-Text) mit Kindern: `CollapsibleSection "Zahlung erfassen" defaultOpen={canPay}` → `PaymentForm` (nur `canPay`); Zahlungsliste; Mahnblock (`dunningSchedule` + `DunningActions` + Mahnungsliste mit PDF/E-Mail) — heute Z. 336–392, 1:1 in `_parts/PaymentSection.tsx`; `AttachmentPanel`; `DocumentChain`.
- `children` (unten): `CollapsibleSection "Positionen" summary={`${lines.length} Positionen · Netto …`}` → Kopftext, `LineItemsTable`, `InvoiceTotals` (heute Z. 250–316 inkl. Abzugsblock der Schlussrechnung), Fußtext, `notes`, interne Notiz; `CorrectionSection` (heute Z. 395–452: Stornieren/Teilgutschrift/Korrekturrechnung/Duplizieren-Erklärtexte — bleibt als Erklärblock, die Knöpfe dort dürfen bleiben, das „Mehr“-Menü verweist nur zusätzlich); `EmailHistory`; Zeitstrahl (`DocumentTimeline`).

- [ ] **Step 3: Verhalten prüfen**

Run: `npm run typecheck && npm run lint && npm run build` — und manuell `grep -n "finalizeAction\|cancelAction\|DunningActions\|PaymentForm\|DocumentChain\|AttachmentPanel\|EmailHistory\|DocumentTimeline\|LineItemsTable\|ConvertMenu\|SendEmailDialog\|DuplicateInvoiceButton" src/app/rechnungen/[id]/**/*.tsx` — jede Komponente genau dort, wo sie vorher war (nichts verloren).

- [ ] **Step 4: Commit**

```bash
git add "src/app/rechnungen/[id]"
git commit -s -m "feat(detail): Rechnungsansicht PDF-zentriert mit Statuskarte und Mehr-Menue (Phase 11d, Task 3)"
```

---

### Task 4: Dokument- und Lieferscheinansicht

**Files:**
- Modify: `src/app/dokumente/[id]/page.tsx`, `src/app/lieferscheine/[id]/page.tsx`
- Create: `src/app/dokumente/[id]/_parts/DocumentMoreMenu.tsx`, `src/app/lieferscheine/[id]/_parts/DeliveryNoteLines.tsx`
- Delete: `src/components/PdfPreview.tsx` (nach Umstellung; `grep -rn PdfPreview src/` leer)

**Interfaces:** Consumes Task 1 (`loadNeighbors("QUOTE"|"DELIVERY_NOTE", …)`), Task 2 (`NavHint`, Bausteine).

- [ ] **Step 1: `dokumente/[id]`**
  - `NavHint href={`/dokumente?kind=${q.kind}`}` rendern (11a-M12).
  - `nav`: Zurück auf `/dokumente?<backQuery>` (Label `KIND_TITLE[q.kind]`-Plural: „Angebote“/„Auftragsbestätigungen“/„Proforma“), Pfeile.
  - `badges`: `StatusBadge`, `BillingStateBadge`, Archiviert, Migrations-Hinweis.
  - `actions`: `DocumentActions` (unverändert, enthält Bearbeiten/Statuswechsel/Archiv/Duplizieren) — Ruling: die Status-Buttons bleiben sichtbar (kein Verstecken im Menü, die Übergänge sind die Primäraktionen dieses Belegtyps); `PDF`-Link; `SendEmailDialog`.
  - `more`: `ConvertMenu` (alle heutigen `show*`-Props unverändert), „→ zur Rechnung“ (falls `convertedToInvoiceId`).
  - `notice`: Proforma-Hinweis.
  - `pdf`: `/api/documents/${q.id}/pdf`.
  - `aside`: `StatusCard` (Kunde-Link, Ansprechpartner, Rechnungsadresse (Snapshot/Adresse), Betreff, Kundenreferenz, Datum, gültig bis, Liefer-/Zahlungsbedingungen, Netto/USt/Brutto), `ShareLinkPanel` (Bedingung wie heute), `AttachmentPanel`, `DocumentChain`.
  - unten: `CollapsibleSection "Positionen"` (Kopftext, `LineItemsTable`, Summen, Fußtext, `notes`, interne Notiz), `EmailHistory`, Zeitstrahl.

- [ ] **Step 2: `lieferscheine/[id]`**
  - `nav`: Zurück `/lieferscheine?<backQuery>`, Pfeile.
  - `actions`: `DocumentActions` (unverändert), `PDF` (nur bei `dn.number`), `SendEmailDialog` (nur `status !== "DRAFT"`).
  - `more`: `ConvertMenu` (Teilrechnung wie heute), im DRAFT: „Druckoptionen“ als Link `#druckoptionen` auf den `PrintOptionsPanel`-Block unten.
  - `notice`: Entwurfs-Hinweis, Bezugsbeleg-Zeile.
  - `pdf`: `dn.number ? /api/delivery-notes/${dn.id}/pdf : null` mit `emptyText="Entwurf — das PDF entsteht mit der Nummernvergabe („Lieferschein erstellen“)."` (Ruling: heutiger PDF-Knopf ist im Entwurf ebenfalls ausgeblendet; kein neuer Pfad).
  - `aside`: `StatusCard` (Kunde-Link, Ausstellungs-, Liefer-, Versanddatum, Anzeigeoptionen als Chips „Preise“, „Art.-Nr.“, „Lieferadresse“ wenn aktiv), `AttachmentPanel`, `DocumentChain`.
  - unten: `CollapsibleSection "Positionen"` → `_parts/DeliveryNoteLines.tsx` (heutige Tabelle Z. 118–145 unverändert), Kopf-/Fußtext, `notes`, interne Notiz; `PrintOptionsPanel` (nur DRAFT, mit `id="druckoptionen"`-Wrapper); `EmailHistory`; Zeitstrahl.

- [ ] **Step 3: `PdfPreview.tsx` löschen**, `grep -rn "PdfPreview" src/ test/ docs/` — Treffer in `docs/` in Task 6 nachziehen.

- [ ] **Step 4: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build`
```bash
git add "src/app/dokumente/[id]" "src/app/lieferscheine/[id]" src/components/PdfPreview.tsx
git commit -s -m "feat(detail): Dokument- und Lieferscheinansicht auf DocumentDetailLayout, PdfPreview entfernt (Phase 11d, Task 4)"
```

---

### Task 5: Shell-Nachträge aus 11a (M4/M5, M10)

**Files:**
- Modify: `src/components/shell/CommandPalette.tsx`, `src/components/shell/Topbar.tsx` (Drawer), `src/components/shell/SidebarGroup.tsx`, `src/lib/nav.ts`
- Test: `test/unit/nav.test.ts`

- [ ] **Step 1: M4/M5** — `SidebarGroup`: jede Gruppe mit Unterpunkten ist auf- und zuklappbar (Chevron rechts, Zustand in `localStorage` `oig.nav.open.<key>`, Default offen); `activeGroupKey` wird für den Default „aktive Gruppe immer offen“ genutzt (ist die aktive Gruppe zugeklappt, wird sie beim Navigieren geöffnet). Prüfen: `grep -rn activeGroupKey src/` — wird die Funktion danach weiterhin nirgends genutzt, entfernen und den Test dazu streichen; wird sie genutzt, bleibt der Test.
- [ ] **Step 2: M10** — `CommandPalette`: Fokusfalle (Tab/Shift+Tab bleiben im Dialog, Muster aus `src/components/editor/blocks/PreviewSheet.tsx`), `role="dialog" aria-modal="true" aria-label="Suche"`, Scroll-Sperre (`document.body.style.overflow = "hidden"` während offen, im Cleanup zurücksetzen). Drawer in `Topbar`: dieselbe Scroll-Sperre und Escape schließt.
- [ ] **Step 3: Gate + Commit**

Run: `npm run typecheck && npm run lint && TZ=UTC npx vitest run test/unit/nav.test.ts`
```bash
git add src/components/shell src/lib/nav.ts test/unit/nav.test.ts
git commit -s -m "fix(shell): Gruppen auf-/zuklappbar, Fokusfalle und Scroll-Sperre fuer Palette und Drawer (Phase 11d, Task 5)"
```

---

### Task 6: Doku, LIMITATIONEN, Smoke, Gesamtprüfung

**Files:**
- Modify: `docs/ARCHITEKTUR.md` (Abschnitt „Belegansicht (Phase 11d)“: Layout, Slots, `neighbors.ts`, `NavHint`; `PdfPreview`-Erwähnungen ersetzen), `docs/ANLEITUNG.md` (Schritt 6/7: Statuskarte, „Mehr“-Menü, Pfeile Alt+←/→, Positionen einklappbar), `docs/LIMITATIONEN.md` (Vor/Zurück nur innerhalb der ersten 200 Treffer des Listenfilters; PDF-Ansicht nutzt den Browser-Viewer — ohne Viewer nur Download; Reihenfolge = Listenreihenfolge, nicht die Belegnummer), `README.md` (Feature-Satz „PDF-centered document view“).

- [ ] **Step 1: Doku schreiben** (Code schlägt Doku — Formulierungen gegen die Komponenten prüfen).
- [ ] **Step 2: Playwright-Smoke** (Skill `webapp-testing`; Seed-Login `admin@example.com` / `demo1234`; Screenshots nach `<scratchpad>/ui-previews/11d-*.png`): Rechnung anlegen → Position per Produktsuche → Speichern → Detailseite zeigt PDF-Rahmen, Statuskarte, „Mehr“-Menü öffnet → Festschreiben → Statuskarte zeigt Nummer/Offen → Zahlung erfassen (eingeklappte Sektion öffnen) → Offen 0 → Liste `/rechnungen?status=paid` → Zeile öffnen → Pfeil „nächster“ (bei ≥2 Treffern) → Dokument `/dokumente?kind=AUFTRAGSBESTAETIGUNG` → Detail: Sidebar markiert „Auftragsbestätigungen“ → Lieferschein-Entwurf: PDF-Platzhalter, „Lieferschein erstellen“ → PDF erscheint. Konsolenfehler protokollieren.
- [ ] **Step 3: Gate** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`.
- [ ] **Step 4: Commit**

```bash
git add README.md docs
git commit -s -m "docs(detail): Belegansicht, Navigation, Grenzen (Phase 11d, Task 6)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. Vollständigkeit: jede Komponente/Aktion der alten drei Seiten ist auf der neuen Seite erreichbar (Diff gegen `git show 2047bd3:src/app/rechnungen/[id]/page.tsx` etc.): Festschreiben, Stornieren, Teilgutschrift, Duplizieren, XRechnung/ZUGFeRD, E-Mail, Konvertieren, Zahlung, Mahnaktionen, Anhänge, Kette, E-Mail-Verlauf, Zeitstrahl, Positionen, Summen inkl. Schlussrechnungs-Abzüge, Skonto, interne Notiz, Share-Link, Druckoptionen (Lieferschein DRAFT).
2. GoBD: keine neuen Schreibpfade; Statuswechsel weiterhin nur über bestehende Actions/Routen; `findFirst` mit `orgId` unverändert.
3. `liste`-Parameter: Zod-geparst, nur bekannte Schlüssel, kein Open-Redirect (Zurück-Link ist immer `/<liste-basis>?<query>`), fremde Org sieht keine Nachbarn (Listenfunktionen sind org-scoped).
4. Sidebar-Hint: `/dokumente/<id>` markiert die Art des Dokuments; nach Verlassen der Seite wird der Hint zurückgesetzt (Cleanup).
5. Keine Hydration-Warnungen (`<details>`-Menüs, iframe), keine verschachtelten `<form>`; A11y: `aria-disabled` Pfeile, Menü per Tastatur bedienbar.
6. Smoke-Screenshots und die Betreiberfrage: „Ist die Belegansicht jetzt so übersichtlich wie bei sevDesk?“ — PDF mittig, Status rechts, Aktionen oben.
