# Phase 11a — App-Shell, Sidebar, globale Suche — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die horizontale Hauptnavigation wird durch eine linke Sidebar nach sevDesk-Vorbild ersetzt, ergänzt um eine globale Suche mit Befehlspalette (⌘K) und einheitliche Seitenköpfe.

**Architecture:** Das Root-Layout rendert eine `AppShell` (Sidebar links, Inhalt rechts, mobile Topbar mit Drawer). Navigationsstruktur liegt als reine Daten in `src/lib/nav.ts`, aktive Gruppe wird aus dem Pfad abgeleitet. Die Suche ist eine Domain-Funktion (`src/domain/search/query.ts`) über Prisma mit Org-Scoping, exponiert über `GET /api/search` (Zod), konsumiert von einer eigenen Befehlspalette ohne neue Abhängigkeit.

**Tech Stack:** Next.js App Router (React Server + Client Components), Tailwind v4, Prisma (SQLite + Postgres via `ciContains`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md` (Branch `specs`), Abschnitte 2 „Navigation", „Globale Suche", 3, 4, 5 (11a).

## Global Constraints

- TypeScript strict, kein `any`; `unknown` + Narrowing (CONTRIBUTING).
- Zod an jeder Boundary: `GET /api/search` validiert `q` und `limit`.
- Prisma immer mit `select`; Org-Scoping über `getActiveOrg()` (`src/lib/org.ts`); Case-insensitive Suche NUR über `ciContains` aus `src/lib/db.ts` (Postgres `mode: "insensitive"`, SQLite ohne).
- Keine neue Abhängigkeit (Befehlspalette selbst gebaut; Icons als Inline-SVG).
- Öffentliche Seiten (`/angebot/…`, Header `x-oig-public`) behalten die schlanke Hülle ohne Sidebar (`PUBLIC_NO_NAV_HEADER` aus `src/proxy.ts`).
- Dateien kebab-case, Komponenten PascalCase, Konstanten UPPER_SNAKE_CASE.
- Vor jedem Commit: `npm run typecheck && npm run lint`; vor dem Abschluss zusätzlich `TZ=UTC npm test && npm run build`.
- Jeder Commit mit `git commit -s` (DCO) auf Branch `phase-11a/shell` aus Fork-`main`.
- Interne Notizen erscheinen nirgends in Suchtreffern (nur Nummer, Kunde, Name, Artikel-/Kundennummer, E-Mail).

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/lib/nav.ts` | Navigationsdaten (`NAV_GROUPS`, `SETTINGS_ITEMS`), `activeGroupKey(pathname, search)`, `isItemActive(item, pathname, search)` — rein, testbar |
| `src/schemas/search.ts` | `searchQuerySchema` (`q`, `limit`) |
| `src/domain/search/query.ts` | `globalSearch(orgId, input)` → gruppierte Treffer (Prisma) |
| `src/app/api/search/route.ts` | `GET /api/search?q=&limit=` (Zod, 400/500, Org-Scoping) |
| `src/components/shell/AppShell.tsx` | Server-Komponente: Layout-Gerüst (Sidebar + Inhalt), erhält `orgName`, `unreadCount` |
| `src/components/shell/Sidebar.tsx` | Client: Gruppen, aktive Erkennung, Einklappen (`localStorage`), Drawer-Zustand |
| `src/components/shell/SidebarGroup.tsx` | Client: eine Gruppe mit Unterpunkten |
| `src/components/shell/Topbar.tsx` | Client: mobile Kopfleiste mit Burger |
| `src/components/shell/CommandPalette.tsx` | Client: ⌘K-Palette, Suche via `/api/search`, Schnellaktionen |
| `src/components/shell/NavIcons.tsx` | Inline-SVG-Icons (16 Stück) |
| `src/components/PageHeader.tsx` | Einheitlicher Seitenkopf (Titel, Untertitel, Aktionen rechts) |
| `src/app/layout.tsx` | Nutzt `AppShell`; Public-Hülle unverändert |
| `test/unit/nav.test.ts` | aktive Gruppe/Item aus Pfad |
| `test/integration/search.test.ts` | Domain-Suche + Route (Org-Scoping, Zod, Limits) |

Entfernt: `src/components/MainNav.tsx`. `NotificationBell` und `LogoutButton` bleiben und werden in der Sidebar verwendet.

---

### Task 1: Navigationsmodell `src/lib/nav.ts`

**Files:**
- Create: `src/lib/nav.ts`
- Test: `test/unit/nav.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NavItem { href: string; label: string; icon?: NavIconName; exact?: boolean; badge?: "notifications" }
  export interface NavGroup { key: string; label: string; icon: NavIconName; href?: string; items: NavItem[] }
  export type NavIconName = "home"|"quote"|"order"|"delivery"|"invoice"|"credit"|"recurring"|"dunning"|"customer"|"product"|"mail"|"bell"|"settings"|"search"|"menu"|"close";
  export const NAV_GROUPS: readonly NavGroup[];
  export function itemMatches(item: NavItem, pathname: string, search: string): boolean;
  export function activeGroupKey(pathname: string, search: string): string | null;
  ```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/nav.test.ts
import { describe, it, expect } from "vitest";
import { NAV_GROUPS, activeGroupKey, itemMatches } from "@/lib/nav";

describe("nav — aktive Gruppe/Item aus Pfad", () => {
  it("Übersicht nur bei exakt '/'", () => {
    expect(activeGroupKey("/", "")).toBe("home");
    expect(activeGroupKey("/rechnungen", "")).not.toBe("home");
  });
  it("Rechnungen-Detail gehört zu Verkauf", () => {
    expect(activeGroupKey("/rechnungen/abc123", "")).toBe("verkauf");
  });
  it("Gutschriften-Item matcht nur mit type=CREDIT_NOTE, Rechnungen-Item nur ohne", () => {
    const verkauf = NAV_GROUPS.find((g) => g.key === "verkauf")!;
    const rechnungen = verkauf.items.find((i) => i.label === "Rechnungen")!;
    const gutschriften = verkauf.items.find((i) => i.label === "Gutschriften")!;
    expect(itemMatches(gutschriften, "/rechnungen", "?type=CREDIT_NOTE")).toBe(true);
    expect(itemMatches(rechnungen, "/rechnungen", "?type=CREDIT_NOTE")).toBe(false);
    expect(itemMatches(rechnungen, "/rechnungen", "")).toBe(true);
    expect(itemMatches(rechnungen, "/rechnungen/neu", "")).toBe(true);
  });
  it("Dokumente-Items unterscheiden nach kind", () => {
    const verkauf = NAV_GROUPS.find((g) => g.key === "verkauf")!;
    const angebote = verkauf.items.find((i) => i.label === "Angebote")!;
    const ab = verkauf.items.find((i) => i.label === "Auftragsbestätigungen")!;
    expect(itemMatches(angebote, "/dokumente", "?kind=ANGEBOT")).toBe(true);
    expect(itemMatches(ab, "/dokumente", "?kind=ANGEBOT")).toBe(false);
    expect(itemMatches(angebote, "/dokumente", "")).toBe(true); // ohne kind: Angebote als Default aktiv
  });
  it("Einstellungen-Unterseiten gehören zu verwaltung", () => {
    expect(activeGroupKey("/einstellungen/briefpapier", "")).toBe("verwaltung");
    expect(activeGroupKey("/kunden/xyz", "")).toBe("verwaltung");
  });
  it("jede Gruppe hat eindeutige hrefs", () => {
    const hrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
```

- [ ] **Step 2: Test laufen lassen, muss fehlschlagen**

Run: `npx vitest run test/unit/nav.test.ts`
Expected: FAIL — `Cannot find module '@/lib/nav'`

- [ ] **Step 3: Implementierung**

```ts
// src/lib/nav.ts
/**
 * Navigationsmodell der App-Shell (Phase 11a). Reine Daten + Pfadlogik, keine React-
 * Abhaengigkeit — damit die aktive Erkennung unit-testbar ist. Gruppen und Reihenfolge
 * laut Spec Phase 11 (Abschnitt 2, "Navigation").
 */
export type NavIconName =
  | "home" | "quote" | "order" | "delivery" | "invoice" | "credit" | "recurring" | "dunning"
  | "customer" | "product" | "mail" | "bell" | "settings" | "search" | "menu" | "close";

export interface NavItem {
  href: string;
  label: string;
  icon?: NavIconName;
  /** true: nur exakter Pfad (ohne Unterpfade) gilt als aktiv. */
  exact?: boolean;
  /** Zeigt den Ungelesen-Zaehler der Benachrichtigungen. */
  badge?: "notifications";
}

export interface NavGroup {
  key: string;
  label: string;
  icon: NavIconName;
  /** Gruppe ist selbst ein Link (Uebersicht) und hat keine Unterpunkte. */
  href?: string;
  items: NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { key: "home", label: "Übersicht", icon: "home", href: "/", items: [] },
  {
    key: "verkauf",
    label: "Verkauf",
    icon: "invoice",
    items: [
      { href: "/dokumente?kind=ANGEBOT", label: "Angebote", icon: "quote" },
      { href: "/dokumente?kind=AUFTRAGSBESTAETIGUNG", label: "Auftragsbestätigungen", icon: "order" },
      { href: "/dokumente?kind=PROFORMA", label: "Proforma", icon: "quote" },
      { href: "/lieferscheine", label: "Lieferscheine", icon: "delivery" },
      { href: "/rechnungen", label: "Rechnungen", icon: "invoice" },
      { href: "/rechnungen?type=CREDIT_NOTE", label: "Gutschriften", icon: "credit" },
      { href: "/abos", label: "Wiederkehrend", icon: "recurring" },
      { href: "/mahnwesen", label: "Mahnwesen", icon: "dunning" },
    ],
  },
  {
    key: "verwaltung",
    label: "Verwaltung",
    icon: "settings",
    items: [
      { href: "/kunden", label: "Kunden", icon: "customer" },
      { href: "/produkte", label: "Produkte", icon: "product" },
      { href: "/emails", label: "E-Mails", icon: "mail" },
      { href: "/benachrichtigungen", label: "Benachrichtigungen", icon: "bell", badge: "notifications" },
      { href: "/einstellungen", label: "Einstellungen", icon: "settings" },
    ],
  },
];

/** Unterpunkte der Einstellungen (werden unter "Einstellungen" eingeblendet, wenn aktiv). */
export const SETTINGS_ITEMS: readonly NavItem[] = [
  { href: "/einstellungen", label: "Stammdaten", exact: true },
  { href: "/einstellungen/belege", label: "Belege" },
  { href: "/einstellungen/nummernkreise", label: "Nummernkreise" },
  { href: "/einstellungen/briefpapier", label: "Briefpapier" },
  { href: "/einstellungen/druckoptionen", label: "Druckoptionen" },
  { href: "/einstellungen/email", label: "E-Mail-Versand" },
  { href: "/einstellungen/vorlagen", label: "Textvorlagen" },
  { href: "/einstellungen/textvorlagen", label: "Dokumenttexte" },
  { href: "/einstellungen/zahlungsmethoden", label: "Zahlungsmethoden" },
  { href: "/einstellungen/mahnwesen", label: "Mahnwesen" },
  { href: "/einstellungen/kundenfelder", label: "Kundenfelder" },
  { href: "/einstellungen/benachrichtigungen", label: "Benachrichtigungen" },
  { href: "/einstellungen/automatisierung", label: "Automatisierung" },
  { href: "/einstellungen/api", label: "API" },
  { href: "/einstellungen/webhooks", label: "Webhooks" },
];

function splitHref(href: string): { path: string; params: URLSearchParams } {
  const [path, query = ""] = href.split("?");
  return { path, params: new URLSearchParams(query) };
}

/**
 * Ein Item ist aktiv, wenn der Pfad gleich ist oder (ohne `exact`) darunter liegt UND
 * alle Query-Parameter des Items in der aktuellen Query stehen. Items OHNE Query gelten
 * nur, wenn die aktuelle Query KEINEN der Parameter setzt, die ein Geschwister-Item mit
 * gleichem Pfad nutzt (sonst waeren "Rechnungen" und "Gutschriften" gleichzeitig aktiv).
 * Ausnahme: `/dokumente` ohne `kind` zaehlt als "Angebote" (Default der Liste).
 */
export function itemMatches(item: NavItem, pathname: string, search: string): boolean {
  const { path, params } = splitHref(item.href);
  const current = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pathOk = item.exact ? pathname === path : pathname === path || pathname.startsWith(path + "/");
  if (!pathOk) return false;

  if ([...params.keys()].length > 0) {
    for (const [k, v] of params) {
      const cur = current.get(k);
      if (cur === v) continue;
      if (k === "kind" && v === "ANGEBOT" && cur === null) continue; // Default der Dokumentliste
      return false;
    }
    return true;
  }
  // Item ohne Query: nicht aktiv, wenn ein Geschwister mit gleichem Pfad ueber Query matcht.
  const siblings = NAV_GROUPS.flatMap((g) => g.items).filter((s) => s !== item && splitHref(s.href).path === path);
  return !siblings.some((s) => [...splitHref(s.href).params].some(([k, v]) => current.get(k) === v));
}

export function activeGroupKey(pathname: string, search: string): string | null {
  for (const g of NAV_GROUPS) {
    if (g.href !== undefined && g.items.length === 0) {
      if (pathname === g.href) return g.key;
      continue;
    }
    if (g.items.some((i) => itemMatches(i, pathname, search))) return g.key;
  }
  return null;
}
```

- [ ] **Step 4: Test laufen lassen, muss bestehen**

Run: `npx vitest run test/unit/nav.test.ts`
Expected: PASS (6 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/nav.ts test/unit/nav.test.ts
git commit -s -m "feat(shell): Navigationsmodell mit Pfad-Erkennung (Phase 11a, Task 1)"
```

---

### Task 2: Such-Domain `globalSearch`

**Files:**
- Create: `src/schemas/search.ts`, `src/domain/search/query.ts`
- Test: `test/integration/search.test.ts` (Teil 1)

**Interfaces:**
- Consumes: `ciContains(value)` aus `src/lib/db.ts`, `dbInternal`.
- Produces:
  ```ts
  export const searchQuerySchema = z.object({ q: z.string().trim().min(2).max(80), limit: z.coerce.number().int().min(1).max(20).default(8) });
  export type SearchQuery = z.infer<typeof searchQuerySchema>;
  export type SearchGroupKey = "invoices" | "documents" | "deliveryNotes" | "customers" | "products";
  export interface SearchHit { id: string; title: string; subtitle: string | null; href: string }
  export interface SearchResult { groups: { key: SearchGroupKey; label: string; hits: SearchHit[] }[] }
  export async function globalSearch(orgId: string, input: SearchQuery): Promise<SearchResult>;
  ```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/integration/search.test.ts
/**
 * Phase 11a — globale Suche: Domain (`globalSearch`) und Route (`GET /api/search`).
 * Eigene Org je Testdatei; Fremd-Org darf nichts liefern. Testjahr 2071 (Nummernkreise).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { globalSearch } from "@/domain/search/query";
import { searchQuerySchema } from "@/schemas/search";
import type { CreateInvoiceInput } from "@/schemas";

let orgId: string;
let otherOrgId: string;
let customerId: string;
let invoiceNumber: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Suche Test GmbH", addressLine1: "Suchweg 1", postalCode: "10115", city: "Berlin", vatId: "DE711111111", taxNumber: "71/1" },
  });
  orgId = org.id;
  orgStore.id = orgId;
  await ensureOrgMasterdata(dbInternal, orgId);
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremde Org", addressLine1: "Anderswo 2", postalCode: "20095", city: "Hamburg", vatId: "DE722222222", taxNumber: "72/2" },
  });
  otherOrgId = other.id;
  await ensureOrgMasterdata(dbInternal, otherOrgId);

  const c = await dbInternal.customer.create({
    data: { orgId, name: "Zebra Logistik AG", customerNumber: "K-7100", email: "buchhaltung@zebra.example", addressLine1: "Hafen 3", postalCode: "28195", city: "Bremen", type: "BUSINESS" },
  });
  customerId = c.id;
  await dbInternal.customer.create({
    data: { orgId: otherOrgId, name: "Zebra Fremd GmbH", addressLine1: "x", postalCode: "1", city: "y", type: "BUSINESS" },
  });
  await dbInternal.product.create({ data: { orgId, name: "Zebra-Etikettendrucker", articleNumber: "ZEB-500", netPriceCents: 19900 } });

  const input: CreateInvoiceInput = {
    customerId,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: new Date("2071-03-01T12:00:00.000Z"),
    dueDate: new Date("2071-03-15T12:00:00.000Z"),
    lines: [{ lineType: "ITEM", description: "Etiketten", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  };
  const draft = await createDraftInvoice(orgId, input);
  const fin = await finalizeInvoice(draft.id, { now: new Date("2071-03-01T12:00:00.000Z"), actor: "test" });
  invoiceNumber = fin.number!;
});

describe("searchQuerySchema", () => {
  it("lehnt zu kurze Suchbegriffe ab und setzt limit-Default 8", () => {
    expect(searchQuerySchema.safeParse({ q: "a" }).success).toBe(false);
    const ok = searchQuerySchema.safeParse({ q: "  ab " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ q: "ab", limit: 8 });
    expect(searchQuerySchema.safeParse({ q: "abc", limit: 21 }).success).toBe(false);
  });
});

describe("globalSearch", () => {
  it("findet Kunde nach Name, Kundennummer und E-Mail — nur in der eigenen Org", async () => {
    const byName = await globalSearch(orgId, { q: "zebra", limit: 8 });
    const customers = byName.groups.find((g) => g.key === "customers")!;
    expect(customers.hits.map((h) => h.title)).toEqual(["Zebra Logistik AG"]);
    expect(customers.hits[0]!.href).toBe(`/kunden/${customerId}`);
    expect(customers.hits[0]!.subtitle).toContain("K-7100");

    const byNumber = await globalSearch(orgId, { q: "K-7100", limit: 8 });
    expect(byNumber.groups.find((g) => g.key === "customers")!.hits).toHaveLength(1);
    const byMail = await globalSearch(orgId, { q: "zebra.example", limit: 8 });
    expect(byMail.groups.find((g) => g.key === "customers")!.hits).toHaveLength(1);

    const foreign = await globalSearch(otherOrgId, { q: "Logistik", limit: 8 });
    expect(foreign.groups.find((g) => g.key === "customers")!.hits).toHaveLength(0);
  });

  it("findet Produkt nach Name und Artikelnummer", async () => {
    const r = await globalSearch(orgId, { q: "ZEB-5", limit: 8 });
    const products = r.groups.find((g) => g.key === "products")!;
    expect(products.hits[0]!.title).toBe("Zebra-Etikettendrucker");
    expect(products.hits[0]!.href).toMatch(/^\/produkte\//);
  });

  it("findet Rechnung nach Nummer und nach Kundenname, Treffer verlinkt die Detailseite", async () => {
    const byNumber = await globalSearch(orgId, { q: invoiceNumber, limit: 8 });
    const invoices = byNumber.groups.find((g) => g.key === "invoices")!;
    expect(invoices.hits).toHaveLength(1);
    expect(invoices.hits[0]!.title).toBe(invoiceNumber);
    expect(invoices.hits[0]!.subtitle).toContain("Zebra Logistik AG");
    expect(invoices.hits[0]!.href).toMatch(/^\/rechnungen\//);

    const byCustomer = await globalSearch(orgId, { q: "Zebra Logistik", limit: 8 });
    expect(byCustomer.groups.find((g) => g.key === "invoices")!.hits.length).toBeGreaterThanOrEqual(1);
  });

  it("liefert leere Gruppen bei Nicht-Treffer und respektiert limit", async () => {
    const none = await globalSearch(orgId, { q: "gibtesnicht-xyz", limit: 8 });
    expect(none.groups.every((g) => g.hits.length === 0)).toBe(true);
    for (let i = 0; i < 3; i++) {
      await dbInternal.customer.create({ data: { orgId, name: `Limit Kunde ${i}`, addressLine1: "a", postalCode: "1", city: "b", type: "BUSINESS" } });
    }
    const limited = await globalSearch(orgId, { q: "Limit Kunde", limit: 2 });
    expect(limited.groups.find((g) => g.key === "customers")!.hits).toHaveLength(2);
  });

  it("gibt Notizen nie aus (Kunden-Notiz, interne Rechnungsnotiz)", async () => {
    await dbInternal.customer.update({ where: { id: customerId }, data: { notes: "GEHEIM-NOTIZ" } });
    await dbInternal.invoice.updateMany({ where: { orgId, customerId }, data: { internalNotes: "GEHEIM-NOTIZ" } });
    const r = await globalSearch(orgId, { q: "GEHEIM", limit: 8 });
    expect(r.groups.every((g) => g.hits.length === 0)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("GEHEIM");
  });
});
```

Pflichtfelder laut Schema: `Customer` = orgId, name, addressLine1, postalCode, city; `Product` = orgId, name, netPriceCents. `Invoice.internalNotes` (Phase 0) und `Customer.notes` sind die Notizfelder. `finalizeInvoice(invoiceId, { now, actor })` liefert die festgeschriebene Rechnung inkl. `number` (Vorlage: `test/integration/scheduler.test.ts`). `invoice.updateMany` auf `internalNotes` läuft über `dbInternal` (kein GoBD-Guard) — im Test zulässig.

- [ ] **Step 2: Test laufen lassen, muss fehlschlagen**

Run: `npx vitest run test/integration/search.test.ts`
Expected: FAIL — `Cannot find module '@/domain/search/query'`

- [ ] **Step 3: Schema und Domain implementieren**

```ts
// src/schemas/search.ts
import { z } from "zod";

/** Phase 11a — Query der globalen Suche (`GET /api/search`). */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, "Mindestens 2 Zeichen").max(80),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
```

```ts
// src/domain/search/query.ts
/**
 * Globale Suche (Phase 11a, Spec Abschnitt 2 "Globale Suche"): Rechnungen/Gutschriften,
 * Angebote/AB/Proforma, Lieferscheine, Kunden, Produkte — je Gruppe max. `limit` Treffer,
 * org-gescoped, case-insensitiv ueber `ciContains` (Postgres `mode: insensitive`, SQLite
 * nativ). Es werden NUR Nummer, Kundenname, Name, Artikel-/Kundennummer und E-Mail
 * durchsucht — nie interne Notizen (§48).
 */
import { dbInternal, ciContains } from "@/lib/db";
import type { SearchQuery } from "@/schemas/search";

export type SearchGroupKey = "invoices" | "documents" | "deliveryNotes" | "customers" | "products";

export interface SearchHit {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

export interface SearchGroup {
  key: SearchGroupKey;
  label: string;
  hits: SearchHit[];
}

export interface SearchResult {
  groups: SearchGroup[];
}

const KIND_LABEL: Record<string, string> = {
  ANGEBOT: "Angebot",
  AUFTRAGSBESTAETIGUNG: "Auftragsbestätigung",
  PROFORMA: "Proforma",
};

const INVOICE_TYPE_LABEL: Record<string, string> = {
  INVOICE: "Rechnung",
  CREDIT_NOTE: "Gutschrift",
  CORRECTION: "Korrekturrechnung",
};

export async function globalSearch(orgId: string, input: SearchQuery): Promise<SearchResult> {
  const q = ciContains(input.q);
  const take = input.limit;

  const [invoices, documents, deliveryNotes, customers, products] = await Promise.all([
    dbInternal.invoice.findMany({
      where: { orgId, OR: [{ number: q }, { customer: { name: q } }] },
      select: { id: true, number: true, type: true, status: true, customer: { select: { name: true } } },
      orderBy: { issueDate: "desc" },
      take,
    }),
    dbInternal.quote.findMany({
      where: { orgId, OR: [{ number: q }, { customer: { name: q } }] },
      select: { id: true, number: true, kind: true, status: true, customer: { select: { name: true } } },
      orderBy: { issueDate: "desc" },
      take,
    }),
    dbInternal.deliveryNote.findMany({
      where: { orgId, OR: [{ number: q }, { customer: { name: q } }] },
      select: { id: true, number: true, status: true, customer: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take,
    }),
    dbInternal.customer.findMany({
      where: { orgId, OR: [{ name: q }, { customerNumber: q }, { email: q }] },
      select: { id: true, name: true, customerNumber: true, email: true },
      orderBy: { name: "asc" },
      take,
    }),
    dbInternal.product.findMany({
      where: { orgId, OR: [{ name: q }, { articleNumber: q }] },
      select: { id: true, name: true, articleNumber: true },
      orderBy: { name: "asc" },
      take,
    }),
  ]);

  return {
    groups: [
      {
        key: "invoices",
        label: "Rechnungen",
        hits: invoices.map((i) => ({
          id: i.id,
          title: i.number ?? "Entwurf",
          subtitle: `${INVOICE_TYPE_LABEL[i.type] ?? i.type} · ${i.customer.name} · ${i.status}`,
          href: `/rechnungen/${i.id}`,
        })),
      },
      {
        key: "documents",
        label: "Angebote & Aufträge",
        hits: documents.map((d) => ({
          id: d.id,
          title: d.number ?? "Entwurf",
          subtitle: `${KIND_LABEL[d.kind] ?? d.kind} · ${d.customer.name} · ${d.status}`,
          href: `/dokumente/${d.id}`,
        })),
      },
      {
        key: "deliveryNotes",
        label: "Lieferscheine",
        hits: deliveryNotes.map((n) => ({
          id: n.id,
          title: n.number ?? "Entwurf",
          subtitle: `${n.customer.name} · ${n.status}`,
          href: `/lieferscheine/${n.id}`,
        })),
      },
      {
        key: "customers",
        label: "Kunden",
        hits: customers.map((c) => ({
          id: c.id,
          title: c.name,
          subtitle: [c.customerNumber, c.email].filter(Boolean).join(" · ") || null,
          href: `/kunden/${c.id}`,
        })),
      },
      {
        key: "products",
        label: "Produkte",
        hits: products.map((p) => ({
          id: p.id,
          title: p.name,
          subtitle: p.articleNumber ?? null,
          href: `/produkte/${p.id}`,
        })),
      },
    ],
  };
}
```

Die Detailrouten `/kunden/[id]`, `/produkte/[id]`, `/dokumente/[id]`, `/lieferscheine/[id]` existieren (geprüft 2026-09-07).

- [ ] **Step 4: Tests laufen lassen**

Run: `npx vitest run test/integration/search.test.ts`
Expected: PASS (6 Tests)

- [ ] **Step 5: Typecheck, Lint, Commit**

```bash
npm run typecheck && npm run lint
git add src/schemas/search.ts src/domain/search/query.ts test/integration/search.test.ts
git commit -s -m "feat(search): globale Suche als Domain-Funktion mit Org-Scoping (Phase 11a, Task 2)"
```

---

### Task 3: Route `GET /api/search`

**Files:**
- Create: `src/app/api/search/route.ts`
- Test: `test/integration/search.test.ts` (Teil 2, anhängen)

**Interfaces:**
- Consumes: `globalSearch`, `searchQuerySchema`, `getActiveOrg`.
- Produces: `GET /api/search?q=&limit=` → `200 { groups }`, `400 { error: "…", details }` bei Zod-Fehler, `500` sonst. Wird von `CommandPalette` (Task 5) aufgerufen.

- [ ] **Step 1: Failing test anhängen**

```ts
// test/integration/search.test.ts — am Ende ergänzen
import { GET as searchGet } from "@/app/api/search/route";

describe("GET /api/search", () => {
  it("400 bei zu kurzem q, 200 mit Gruppen sonst", async () => {
    const bad = await searchGet(new Request("http://localhost/api/search?q=a"));
    expect(bad.status).toBe(400);
    const ok = await searchGet(new Request(`http://localhost/api/search?q=${encodeURIComponent("Zebra")}&limit=3`));
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { groups: { key: string; hits: unknown[] }[] };
    expect(json.groups.map((g) => g.key)).toEqual(["invoices", "documents", "deliveryNotes", "customers", "products"]);
    expect(json.groups.find((g) => g.key === "customers")!.hits.length).toBeGreaterThanOrEqual(1);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});
```

- [ ] **Step 2: Test laufen lassen, muss fehlschlagen**

Run: `npx vitest run test/integration/search.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/search/route'`

- [ ] **Step 3: Route implementieren**

```ts
// src/app/api/search/route.ts
import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { searchQuerySchema } from "@/schemas/search";
import { globalSearch } from "@/domain/search/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phase 11a: `GET /api/search?q=&limit=` — globale Suche fuer die Befehlspalette. */
export async function GET(req: Request) {
  try {
    const org = await getActiveOrg();
    const { searchParams } = new URL(req.url);
    const parsed = searchQuerySchema.safeParse({
      q: searchParams.get("q") ?? "",
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Ungültige Suchanfrage", details: parsed.error.flatten() }, { status: 400 });
    }
    const result = await globalSearch(org.id, parsed.data);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("GET /api/search:", e);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Tests laufen lassen**

Run: `npx vitest run test/integration/search.test.ts`
Expected: PASS (7 Tests)

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run lint
git add src/app/api/search/route.ts test/integration/search.test.ts
git commit -s -m "feat(search): GET /api/search mit Zod-Validierung (Phase 11a, Task 3)"
```

---

### Task 4: App-Shell mit Sidebar, Drawer und Root-Layout

**Files:**
- Create: `src/components/shell/NavIcons.tsx`, `src/components/shell/SidebarGroup.tsx`, `src/components/shell/Sidebar.tsx`, `src/components/shell/Topbar.tsx`, `src/components/shell/AppShell.tsx`
- Modify: `src/app/layout.tsx` (authentifizierter Zweig), `src/app/globals.css` (nichts nötig, prüfen)
- Delete: `src/components/MainNav.tsx`

**Interfaces:**
- Consumes: `NAV_GROUPS`, `SETTINGS_ITEMS`, `itemMatches`, `activeGroupKey` (Task 1); `NotificationBell`, `LogoutButton` (bestehend); `unreadCount(orgId)` aus `src/domain/notifications/create.ts`; `getActiveOrg`.
- Produces: `AppShell({ orgName, unreadCount, children })` (Server-Komponente); `Sidebar({ orgName, unreadCount, onOpenSearch? })` (Client). Task 5 hängt die Befehlspalette in `Sidebar` ein (Slot `searchSlot`).

- [ ] **Step 1: Icons**

```tsx
// src/components/shell/NavIcons.tsx
import type { NavIconName } from "@/lib/nav";

const PATHS: Record<NavIconName, string> = {
  home: "M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z",
  quote: "M7 3h7l5 5v13H7zM14 3v5h5M9 13h6M9 17h6",
  order: "M5 4h14v16H5zM9 9h6M9 13h6M9 17h3",
  delivery: "M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  invoice: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  credit: "M4 6h16v12H4zM4 10h16M8 15h3",
  recurring: "M4 12a8 8 0 0114-5l2 2M20 12a8 8 0 01-14 5l-2-2M18 4v5h-5M6 20v-5h5",
  dunning: "M12 3l9 16H3zM12 10v4M12 17h.01",
  customer: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  product: "M12 3l9 5-9 5-9-5zM3 8v8l9 5 9-5V8",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  bell: "M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L6.5 8 4.5 7.5l-1 3 2 1v1l-2 1 1 3 2-.5L8 17.5l-.5 2 3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
};

export function NavIcon({ name, className = "h-4 w-4" }: { name: NavIconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
```

- [ ] **Step 2: SidebarGroup**

```tsx
// src/components/shell/SidebarGroup.tsx
"use client";

import Link from "next/link";
import type { NavGroup, NavItem } from "@/lib/nav";
import { itemMatches, SETTINGS_ITEMS } from "@/lib/nav";
import { NavIcon } from "./NavIcons";

interface Props {
  group: NavGroup;
  pathname: string;
  search: string;
  active: boolean;
  collapsed: boolean;
  unreadCount: number;
  onNavigate?: () => void;
}

function ItemLink({ item, active, collapsed, badge, onNavigate, indent }: { item: NavItem; active: boolean; collapsed: boolean; badge: number; onNavigate?: () => void; indent?: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-md py-1.5 text-sm ${indent ? "pl-9 pr-2" : "px-2"} ${
        active ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      {item.icon && <NavIcon name={item.icon} className="h-4 w-4 shrink-0" />}
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && item.badge === "notifications" && badge > 0 && (
        <span className="ml-auto rounded-full bg-indigo-600 px-1.5 text-[10px] font-semibold text-white">{badge}</span>
      )}
    </Link>
  );
}

export function SidebarGroup({ group, pathname, search, collapsed, unreadCount, onNavigate }: Props) {
  if (group.href !== undefined && group.items.length === 0) {
    return (
      <ItemLink
        item={{ href: group.href, label: group.label, icon: group.icon, exact: true }}
        active={pathname === group.href}
        collapsed={collapsed}
        badge={0}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <div className="space-y-0.5">
      {!collapsed && <div className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</div>}
      {collapsed && <div className="my-2 border-t border-slate-200" />}
      {group.items.map((item) => {
        const isActive = itemMatches(item, pathname, search);
        const showSettings = item.href === "/einstellungen" && isActive && !collapsed;
        return (
          <div key={item.href}>
            <ItemLink item={item} active={isActive} collapsed={collapsed} badge={unreadCount} onNavigate={onNavigate} />
            {showSettings && (
              <div className="mt-0.5 space-y-0.5">
                {SETTINGS_ITEMS.map((s) => (
                  <ItemLink key={s.href} item={s} active={itemMatches(s, pathname, search)} collapsed={false} badge={0} onNavigate={onNavigate} indent />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Sidebar (Client) mit Einklappen und Drawer**

```tsx
// src/components/shell/Sidebar.tsx
"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { NAV_GROUPS, activeGroupKey } from "@/lib/nav";
import { LogoutButton } from "@/components/LogoutButton";
import { NavIcon } from "./NavIcons";
import { SidebarGroup } from "./SidebarGroup";

const COLLAPSED_KEY = "oig.sidebar.collapsed";

interface Props {
  orgName: string;
  unreadCount: number;
  /** Suchfeld/Befehlspalette (Task 5); bis dahin ein Link auf /rechnungen?q= */
  searchSlot?: ReactNode;
  /** Drawer-Modus (mobil): Sidebar liegt als Overlay, Klick auf Link schliesst. */
  drawer?: boolean;
  onClose?: () => void;
}

export function Sidebar({ orgName, unreadCount, searchSlot, drawer = false, onClose }: Props) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const searchStr = search ? `?${search}` : "";
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // localStorage nur im Effekt (SSR-sicher); setState per setTimeout(0) wie NotificationBell.
    const t = setTimeout(() => {
      try {
        setCollapsed(!drawer && localStorage.getItem(COLLAPSED_KEY) === "1");
      } catch {
        // kein Storage (privater Modus) — ausgeklappt bleiben
      }
    }, 0);
    return () => clearTimeout(t);
  }, [drawer]);

  function toggleCollapsed() {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1");
      } catch {
        // ignorieren
      }
      return !v;
    });
  }

  const activeKey = activeGroupKey(pathname, searchStr);
  const width = collapsed ? "w-14" : "w-60";

  return (
    <aside className={`flex h-full ${width} shrink-0 flex-col border-r border-slate-200 bg-white transition-[width]`} aria-label="Hauptnavigation">
      <div className="flex items-center gap-2 px-3 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight" onClick={onClose}>
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-indigo-600 text-sm font-bold text-white">OI</span>
          {!collapsed && (
            <span>
              OpenInvoice <span className="text-slate-400">DE</span>
            </span>
          )}
        </Link>
        {drawer && (
          <button type="button" aria-label="Menü schließen" onClick={onClose} className="ml-auto rounded-md p-1 text-slate-500 hover:bg-slate-100">
            <NavIcon name="close" />
          </button>
        )}
      </div>

      {!collapsed && <div className="px-3 pb-2">{searchSlot}</div>}

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((g) => (
          <SidebarGroup key={g.key} group={g} pathname={pathname} search={searchStr} active={activeKey === g.key} collapsed={collapsed} unreadCount={unreadCount} onNavigate={onClose} />
        ))}
      </nav>

      <div className="border-t border-slate-200 px-3 py-3 text-xs text-slate-500">
        {!collapsed && (
          <div className="mb-2 truncate font-medium text-slate-700" title={orgName}>
            {orgName}
          </div>
        )}
        <div className="flex items-center justify-between">
          {!collapsed && <LogoutButton />}
          {!drawer && (
            <button type="button" onClick={toggleCollapsed} aria-label={collapsed ? "Navigation ausklappen" : "Navigation einklappen"} className="rounded-md p-1 text-slate-500 hover:bg-slate-100">
              <NavIcon name={collapsed ? "menu" : "close"} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Topbar (mobil) und AppShell**

```tsx
// src/components/shell/Topbar.tsx
"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { NavIcon } from "./NavIcons";
import { Sidebar } from "./Sidebar";

interface Props {
  orgName: string;
  unreadCount: number;
  searchSlot?: ReactNode;
}

/** Schmale Kopfleiste unterhalb `lg`: Burger oeffnet die Sidebar als Drawer. */
export function Topbar({ orgName, unreadCount, searchSlot }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 lg:hidden">
        <button type="button" aria-label="Menü" onClick={() => setOpen(true)} className="rounded-md p-1 text-slate-600 hover:bg-slate-100">
          <NavIcon name="menu" className="h-5 w-5" />
        </button>
        <Link href="/" className="font-semibold tracking-tight">
          OpenInvoice <span className="text-slate-400">DE</span>
        </Link>
        <div className="ml-auto">{searchSlot}</div>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Menü schließen" onClick={() => setOpen(false)} className="absolute inset-0 bg-slate-900/40" />
          <div className="absolute inset-y-0 left-0 shadow-xl">
            <Sidebar orgName={orgName} unreadCount={unreadCount} searchSlot={searchSlot} drawer onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
```

```tsx
// src/components/shell/AppShell.tsx
import { Suspense, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface Props {
  orgName: string;
  unreadCount: number;
  searchSlot?: ReactNode;
  children: ReactNode;
}

/**
 * App-Shell (Phase 11a): Sidebar links ab `lg`, darunter Topbar + Drawer. `Sidebar` nutzt
 * `useSearchParams` und braucht deshalb eine Suspense-Grenze (Next App Router).
 */
export function AppShell({ orgName, unreadCount, searchSlot, children }: Props) {
  return (
    <div className="flex min-h-screen">
      <div className="sticky top-0 hidden h-screen lg:block">
        <Suspense fallback={<div className="h-full w-60 border-r border-slate-200 bg-white" />}>
          <Sidebar orgName={orgName} unreadCount={unreadCount} searchSlot={searchSlot} />
        </Suspense>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <Topbar orgName={orgName} unreadCount={unreadCount} searchSlot={searchSlot} />
        </Suspense>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-6 py-6 text-xs text-slate-400">
          OpenInvoice Germany · AGPL-3.0 · Keine Steuer-/Rechtsberatung — siehe COMPLIANCE.md
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Root-Layout umstellen**

Ersetze in `src/app/layout.tsx` den authentifizierten Zweig (ab `const authed = …`) durch:

```tsx
  const userId = await getCurrentUserId();
  const authed = Boolean(userId);

  if (!authed) {
    // Login/Setup: schlanke Huelle ohne Sidebar (wie bisher ohne MainNav)
    return (
      <html lang="de">
        <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
          <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
        </body>
      </html>
    );
  }

  // Org-Name + Ungelesen-Zaehler fuer die Sidebar; beide Aufrufe duerfen nicht die Seite
  // reissen (Setup-Zustand ohne Organisation): still auf Defaults.
  let orgName = "OpenInvoice";
  let unread = 0;
  try {
    const org = await getActiveOrg();
    orgName = org.legalName;
    unread = await unreadCount(org.id);
  } catch {
    // keine Organisation eingerichtet — Shell trotzdem rendern
  }

  return (
    <html lang="de">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <AppShell orgName={orgName} unreadCount={unread}>
          {children}
        </AppShell>
      </body>
    </html>
  );
```

Imports anpassen: `MainNav` entfernen, `Link` entfernen falls ungenutzt, hinzufügen:

```tsx
import { AppShell } from "@/components/shell/AppShell";
import { getActiveOrg } from "@/lib/org";
import { unreadCount } from "@/domain/notifications/create";
```

Dann `git rm src/components/MainNav.tsx`. Prüfe mit `grep -rn "MainNav\|NotificationBell" src/` — `NotificationBell` wird nicht mehr im Header gerendert; der Zähler ist jetzt als Badge am Item „Benachrichtigungen". `NotificationBell.tsx` bleibt vorerst bestehen (wird in 11d entschieden), damit kein toter Import entsteht — falls nirgends mehr importiert, ebenfalls entfernen und den Test `test/…` prüfen (`grep -rn NotificationBell test/`).

- [ ] **Step 6: Build, Typecheck, Lint; visuell prüfen**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: alle grün. Dann `npm run dev`, Login `admin@example.com` / `demo1234` (nach `npm run db:seed`), Seiten `/`, `/rechnungen`, `/rechnungen?type=CREDIT_NOTE`, `/dokumente?kind=ANGEBOT`, `/einstellungen/briefpapier` aufrufen: Sidebar zeigt die richtige aktive Markierung, Einstellungen klappen Unterpunkte auf, Einklappen bleibt nach Reload erhalten, Fenster < 1024 px zeigt Topbar + Drawer. Angebotslink `/angebot/<token>` weiterhin ohne Sidebar.

- [ ] **Step 7: Commit**

```bash
git add src/components/shell src/app/layout.tsx
git rm -q src/components/MainNav.tsx
git commit -s -m "feat(shell): Sidebar-Navigation mit Drawer ersetzt MainNav (Phase 11a, Task 4)"
```

---

### Task 5: Befehlspalette (⌘K) mit globaler Suche

**Files:**
- Create: `src/components/shell/CommandPalette.tsx`
- Modify: `src/components/shell/AppShell.tsx` (searchSlot befüllen)

**Interfaces:**
- Consumes: `GET /api/search` (Task 3) mit Antwort `{ groups: { key, label, hits: { id, title, subtitle, href }[] }[] }`.
- Produces: `CommandPalette()` — Client-Komponente, rendert das Suchfeld (Trigger) und das Overlay; Tastenkürzel ⌘K / Strg+K.

- [ ] **Step 1: Komponente**

```tsx
// src/components/shell/CommandPalette.tsx
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavIcon } from "./NavIcons";

interface Hit {
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}
interface Group {
  key: string;
  label: string;
  hits: Hit[];
}

const QUICK_ACTIONS: Hit[] = [
  { id: "new-invoice", title: "Neue Rechnung", subtitle: "Schnellaktion", href: "/rechnungen/neu" },
  { id: "new-quote", title: "Neues Angebot", subtitle: "Schnellaktion", href: "/dokumente/neu" },
  { id: "new-customer", title: "Neuer Kunde", subtitle: "Schnellaktion", href: "/kunden/neu" },
];

/**
 * Befehlspalette (Phase 11a): Suchfeld in der Sidebar oeffnet ein Overlay; Eingabe wird
 * mit 200 ms Verzoegerung an `GET /api/search` geschickt. Pfeiltasten/Enter navigieren,
 * Escape schliesst. Ohne Eingabe stehen die Schnellaktionen bereit.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const flat = useMemo<Hit[]>(() => {
    if (q.trim().length < 2) return QUICK_ACTIONS;
    return groups.flatMap((g) => g.hits);
  }, [q, groups]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setGroups([]);
    setCursor(0);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        if (res.ok) {
          const json = (await res.json()) as { groups: Group[] };
          setGroups(json.groups.filter((g) => g.hits.length > 0));
          setCursor(0);
        }
      } catch {
        // abgebrochen oder Netzfehler — Liste bleibt
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  function go(hit: Hit) {
    close();
    router.push(hit.href);
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[cursor];
      if (hit) go(hit);
    } else if (e.key === "Escape") {
      close();
    }
  }

  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-left text-sm text-slate-500 hover:bg-white"
        aria-label="Suchen"
      >
        <NavIcon name="search" className="h-4 w-4" />
        <span className="flex-1">Suchen</span>
        <kbd className="rounded border border-slate-200 bg-white px-1 text-[10px] text-slate-400">{isMac ? "⌘K" : "Strg K"}</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Suche">
          <button type="button" aria-label="Schließen" onClick={close} className="absolute inset-0 cursor-default" />
          <div className="relative w-full max-w-xl overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-center gap-2 border-b border-slate-200 px-3">
              <NavIcon name="search" className="h-4 w-4 text-slate-400" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onInputKey}
                placeholder="Belegnummer, Kunde, Produkt …"
                className="w-full py-3 text-sm outline-none"
                aria-label="Suchbegriff"
              />
              {loading && <span className="text-xs text-slate-400">…</span>}
            </div>
            <div className="max-h-[60vh] overflow-y-auto py-2">
              {q.trim().length < 2 ? (
                <Section label="Schnellaktionen" hits={QUICK_ACTIONS} offset={0} cursor={cursor} onPick={go} />
              ) : flat.length === 0 && !loading ? (
                <div className="px-4 py-6 text-center text-sm text-slate-500">Keine Treffer für „{q}“</div>
              ) : (
                groups.reduce<{ nodes: React.ReactNode[]; offset: number }>(
                  (acc, g) => {
                    acc.nodes.push(<Section key={g.key} label={g.label} hits={g.hits} offset={acc.offset} cursor={cursor} onPick={go} />);
                    acc.offset += g.hits.length;
                    return acc;
                  },
                  { nodes: [], offset: 0 },
                ).nodes
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ label, hits, offset, cursor, onPick }: { label: string; hits: Hit[]; offset: number; cursor: number; onPick: (h: Hit) => void }) {
  return (
    <div>
      <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      {hits.map((h, i) => {
        const idx = offset + i;
        return (
          <button
            key={h.id}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(h)}
            className={`flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm ${idx === cursor ? "bg-indigo-50 text-indigo-700" : "text-slate-700 hover:bg-slate-50"}`}
          >
            <span className="font-medium">{h.title}</span>
            {h.subtitle && <span className="truncate text-xs text-slate-500">{h.subtitle}</span>}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: In die Shell einhängen**

In `src/components/shell/AppShell.tsx`:

```tsx
import { CommandPalette } from "./CommandPalette";
// …
export function AppShell({ orgName, unreadCount, children }: Omit<Props, "searchSlot">) {
  const searchSlot = <CommandPalette />;
  // Rest unveraendert, searchSlot an Sidebar und Topbar geben
```

(Die Prop `searchSlot` aus dem `Props`-Interface entfernen; `Sidebar`/`Topbar` behalten ihre Prop.)

- [ ] **Step 3: Prüfen**

Run: `npm run typecheck && npm run lint && npm run build`
Manuell: ⌘K öffnet, Eingabe „RE-" listet Rechnungen gruppiert, Pfeil + Enter navigiert, Escape schließt, leere Eingabe zeigt Schnellaktionen, Klick auf das Suchfeld in der Sidebar und in der mobilen Topbar öffnet ebenfalls.

- [ ] **Step 4: Commit**

```bash
git add src/components/shell/CommandPalette.tsx src/components/shell/AppShell.tsx
git commit -s -m "feat(shell): Befehlspalette mit globaler Suche (⌘K) (Phase 11a, Task 5)"
```

---

### Task 6: Einheitlicher Seitenkopf, Doku, Abschluss

**Files:**
- Create: `src/components/PageHeader.tsx`
- Modify: `src/app/rechnungen/page.tsx`, `src/app/dokumente/page.tsx`, `src/app/lieferscheine/page.tsx`, `src/app/kunden/page.tsx`, `src/app/produkte/page.tsx`, `src/app/abos/page.tsx`, `src/app/mahnwesen/page.tsx`, `src/app/emails/page.tsx`, `src/app/benachrichtigungen/page.tsx`
- Modify: `README.md` (Abschnitt Bedienung/Navigation), `docs/LIMITATIONEN.md` (Suche), `docs/ARCHITEKTUR.md` (Shell-Absatz, falls Abschnitt UI existiert)
- Create: `docs/superpowers/ledgers/2026-09-07-phase-11a-shell.md` (auf Branch `specs`, nicht im Feature-Branch)

**Interfaces:**
- Produces: `PageHeader({ title, subtitle?, actions?, backHref?, backLabel? })`.

- [ ] **Step 1: Komponente**

```tsx
// src/components/PageHeader.tsx
import Link from "next/link";
import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: ReactNode;
  /** Buttons/Links rechts (z. B. "Neue Rechnung"). */
  actions?: ReactNode;
  backHref?: string;
  backLabel?: string;
}

/** Einheitlicher Seitenkopf (Phase 11a): Titel links, Aktionen rechts, optional Zurueck-Link. */
export function PageHeader({ title, subtitle, actions, backHref, backLabel }: Props) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        {backHref && (
          <Link href={backHref} className="text-sm text-slate-500 hover:text-slate-800">
            ← {backLabel ?? "Zurück"}
          </Link>
        )}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Listen-Seiten umstellen**

In jeder der neun Seiten den bestehenden Kopf (Muster: `<div className="flex items-center justify-between"><h1 className="text-2xl font-bold tracking-tight">Rechnungen</h1> …Buttons… </div>`) durch `<PageHeader title="Rechnungen" actions={…dieselben Buttons…} />` ersetzen. Beispiel `src/app/rechnungen/page.tsx`:

```tsx
import { PageHeader } from "@/components/PageHeader";
// …
<PageHeader
  title={type === "CREDIT_NOTE" ? "Gutschriften" : "Rechnungen"}
  subtitle={`${result.total} Belege`}
  actions={
    <Link href="/rechnungen/neu" className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700">
      Neue Rechnung
    </Link>
  }
/>
```

Für jede Seite vorher `grep -n "<h1" <datei>` ausführen und exakt diesen Block ersetzen; Variablennamen (`result.total`, `type`) aus der jeweiligen Datei übernehmen — wo es keinen Zähler gibt, `subtitle` weglassen. Keine weiteren Änderungen an Filtern oder Tabellen.

- [ ] **Step 3: Doku**

`README.md`: am Ende des Abschnitts `## Documents workflow` (vor `## Tech stack`) ergänzen:

```
### Navigation und Suche
Die linke Seitenleiste gliedert die App in Übersicht, Verkauf (Angebote, Auftragsbestätigungen, Proforma, Lieferscheine, Rechnungen, Gutschriften, Wiederkehrend, Mahnwesen) und Verwaltung (Kunden, Produkte, E-Mails, Benachrichtigungen, Einstellungen). Die Leiste lässt sich auf Icons einklappen. Das Suchfeld oben (auch ⌘K / Strg+K) findet Belege nach Nummer oder Kunde sowie Kunden und Produkte und bietet Schnellaktionen.
```

`docs/ARCHITEKTUR.md`: in Abschnitt 1 nach dem Unterabschnitt „Workflow & UX … (Phase 8b)" (vor `## 2. E-Rechnung`) einen Unterabschnitt `### App-Shell, Navigation & Suche (Phase 11a)` mit drei Sätzen: Shell/Sidebar (`src/components/shell`, Navigationsdaten `src/lib/nav.ts`), Suche (`src/domain/search/query.ts`, `GET /api/search`, `ciContains`), öffentliche Hülle unverändert.

`docs/LIMITATIONEN.md`: neuer Abschnitt vor „## Funktionsumfang (geplant)":

```
## Navigation & Suche (Phase 11a)
- **Globale Suche ist eine Teilstring-Suche** (`contains`) über Belegnummer, Kundenname, Kundennummer, E-Mail, Produktname und Artikelnummer — kein Volltext, kein Ranking, keine Suche in Positionen, Betreffs oder Notizen (interne Notizen bewusst nie). Maximal 8 Treffer je Gruppe.
```

- [ ] **Step 4: Gesamtprüfung**

Run:
```bash
npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung
```
Expected: alles grün; Testanzahl = bisherige 1672 + 13 neue.

- [ ] **Step 5: Commit und Ledger**

```bash
git add src/components/PageHeader.tsx src/app/*/page.tsx README.md docs/LIMITATIONEN.md docs/ARCHITEKTUR.md
git commit -s -m "feat(shell): einheitlicher Seitenkopf, Doku Navigation/Suche (Phase 11a, Task 6)"
```

Ledger `docs/superpowers/ledgers/2026-09-07-phase-11a-shell.md` auf Branch `specs` (Worktree `wt-specs`): Tasks 1–6 mit Commit-Hashes, Review-Befunde, Rulings (Angebote-Default bei `/dokumente` ohne `kind`; NotificationBell-Verbleib), offene Punkte für 11b–11d.

---

## Abschluss-Review (opus) — Prüfpunkte

1. Öffentliche Seiten (`/angebot/<token>`) ohne Sidebar; Login/Setup ohne Sidebar.
2. `getActiveOrg()`-Fehler im Layout reißt die Seite nicht (Setup-Zustand).
3. Aktive Markierung bei allen Query-Varianten (`/rechnungen`, `?type=CREDIT_NOTE`, `/dokumente`, `?kind=…`, `/einstellungen/*`).
4. Suche: Org-Scoping, keine internen Notizen, Postgres `mode: insensitive` nur über `ciContains`.
5. Keine neue Dependency in `package.json`.
6. Tastaturbedienung der Palette; `aria-*`-Attribute vorhanden.
7. Playwright-Smoke (Skill `webapp-testing`): Login → ⌘K → „RE-" → Enter öffnet Rechnung → Sidebar markiert „Rechnungen".
8. Build-Größe/Fehler: `npm run build` ohne Warnungen zu `useSearchParams` ohne Suspense.
