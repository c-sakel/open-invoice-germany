# Phase 13c — Belegansicht

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Belegseite wird zur Arbeitsfläche: das PDF bekommt die Werkzeugleiste des eingebauten Browser-Betrachters zurück (Seitenzahl, Blättern, Zoom, Drucken) plus einen Breit/Schmal-Umschalter, das Raster wird breiter, die rechte Spalte zerfällt in klar getrennte Karten (Beleg · Kunde & Betrag · Details · Anhänge · Dokumentenkette), die Zahlungserfassung wandert aus der Dauerkarte in einen Dialog, und jede Belegseite bekommt genau **eine** Primäraktion je Status. Kein neues Datenfeld, keine Migration, keine neue Abhängigkeit.

**Architecture:** Vier Schichten, keine neue. (1) `src/components/detail/*` bleibt der gemeinsame Rahmen aller drei Belegseiten — `PdfStack` verliert `#toolbar=0&navpanes=0` und delegiert an eine kleine Client-Komponente `PdfViewToolbar`; `DocumentDetailLayout` wird breiter und schiebt `nav` in eine Belegkarte; neu ist nur der Kartenbaustein `DetailCard`. (2) Reine Sichtlogik bleibt in `_parts/invoice-view-model.ts` (kein DB-Zugriff, §41-Regel „keine Aktionslogik neben `availableActions`"). (3) Der Zahlungsdialog ist ein Rahmenwechsel um das **unveränderte** `PaymentForm` — dieselbe Route `POST /api/invoices/[id]/payment`, dieselbe Domain-Funktion `recordPayment`. (4) Die Angebotsseite ersetzt ihre client-seitigen Statuskopien durch `availableActions`.

**Tech Stack:** Next.js App Router (Server Components + gezielte `"use client"`-Inseln), Tailwind v4, natives `<dialog>` (Phase-12a-Regel in `globals.css`), Vitest `environment: "node"` — **kein RTL**: Komponenten werden mit `renderToStaticMarkup` (`react-dom/server`) als HTML-String geprüft (Muster `test/unit/charts.test.tsx`) bzw. als Strukturtest über die Quelldatei (Muster `test/unit/dialogs.test.ts`). Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-10-phase-13-listen-editor-beleg-design.md` — Paket **C** (Abschnitt 2: „Große Vorschau", „Detail-Layout", „Zahlung als Dialog", „Primäraktion je Status", „Angebots-Menü"), Struktur Abschnitt 3 Block C, Tests Abschnitt 4 C, Teilphase 3 in Abschnitt 5, Rulings „Kein PDF.js" und „‚Als bezahlt markieren' bucht nicht still".

## Global Constraints

- Branch `phase-13c/belegansicht` aus Fork-`main`, **nach dem Merge von 13b**. Jeder Commit mit `git commit -s`.
- **Setzt 13a voraus:** `src/lib/relative-date.ts#relativeDueLabel` und die fünf neuen `ActionKey`s (`CONVERT`, `DELIVERY_NOTE_CREATE`, `TEMPLATE_SAVE`, `QUOTE_ACCEPT`, `QUOTE_REJECT`) in `src/domain/document/actions.ts` stammen aus 13a. Fehlt eines davon auf `main`, wird es **nicht** hier nachgebaut — der Task, der es braucht, blockiert.
- **Keine neue Abhängigkeit.** Kein PDF.js, kein eigener Betrachter, kein zweiter Serverrender für eine Seitenzahl (Ruling).
- **Kein Geld-Bypass (§50/§51):** Der Zahlungsdialog ruft ausschließlich die bestehende Route `POST /api/invoices/[id]/payment` mit demselben Body wie heute. `recordPayment`, `detectSkonto` und die Skonto-Vorschau (`/skonto-check`) werden **nicht** angefasst. „Als bezahlt markieren" öffnet den vorbelegten Dialog und bucht **nie** ohne Bestätigung.
- **GoBD (§51):** Phase 13c schreibt keine Belegspalte. Der Guard in `src/lib/db.ts` bleibt unverändert; kein neuer Schreibpfad.
- **§48:** `InternalNotesBox` bleibt, wo sie ist (unter der Vorschau, nie in der rechten Spalte, nie im PDF/XML/Mail) — die bestehenden Regressionstests bleiben grün.
- **Nichts doppelt bauen (§1.4/§41):** `availableActions` bleibt die einzige Aktionsmatrix; `DocumentActions`/`DocumentActionsMenuItems`/`ConvertMenu`/`SendEmailDialog`/`PaymentForm` werden wiederverwendet, nicht kopiert. `StatusCard` bleibt der Zeilenbaustein, `DetailCard` ist nur der titelnde Rahmen darum herum.
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen. Deutsche UI-Texte mit echten Umlauten. Fremdanbieternamen nirgends.
- Prüfkette vor jedem Commit **im Vordergrund**: `npm run typecheck && npm run lint && TZ=UTC npm test`. Vor dem letzten Commit zusätzlich `npm run build` und `npm run validate:erechnung`. Alle Bestandstests bleiben grün (§1.7), besonders `test/unit/dialogs.test.ts`, `test/integration/invoice-route.test.ts` und die Zahlungs-/Mahntests.

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/components/detail/PdfStack.tsx` | Werkzeugleiste frei (`#view=FitH`), delegiert an `PdfViewToolbar` |
| `src/components/detail/PdfViewToolbar.tsx` | neu — Client: Breit/Schmal (`localStorage`), neuer Tab, Herunterladen |
| `src/components/detail/DetailCard.tsx` | neu — titelnder Kartenrahmen der rechten Spalte |
| `src/components/detail/DocumentDetailLayout.tsx` | `xl:grid-cols-[minmax(0,1fr)_24rem]`, `nav` in die Belegkarte |
| `src/app/rechnungen/[id]/_parts/invoice-view-model.ts` | neu `primaryAction()` (reine Funktion) |
| `src/app/rechnungen/[id]/_parts/PaymentDialog.tsx` | neu — `<dialog>` um das unveränderte `PaymentForm`, Anker `#zahlung` |
| `src/app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx` | Aufteilung „Kunde & Betrag" / „Details", Zahlungsdialog statt Dauerformular |
| `src/components/PaymentForm.tsx` | optionales `onDone` (Dialog schließen) — sonst unverändert |
| `src/app/rechnungen/[id]/page.tsx` | Primäraktion, „Neue Rechnung", Karten-Kinder |
| `src/app/dokumente/[id]/page.tsx`, `src/app/lieferscheine/[id]/page.tsx` | Mehr-Menü über `availableActions`, gleiche Kartenaufteilung |
| `.../_parts/DocumentStatusCard.tsx`, `.../_parts/DeliveryNoteStatusCard.tsx` | Karten-Rahmen angleichen |
| `test/unit/{pdf-stack,detail-layout,invoice-primary-action,payment-dialog}.test.*` | neu |
| `docs/{LIMITATIONEN,ANLEITUNG,ARCHITEKTUR}.md` | Doku |

---

### Task 1: PDF-Werkzeugleiste frei, Breit/Schmal-Umschalter

**Files:**
- Create: `src/components/detail/PdfViewToolbar.tsx`, `test/unit/pdf-stack.test.tsx`
- Modify: `src/components/detail/PdfStack.tsx`

**Befund (verifiziert):** `PdfStack.tsx:24` rendert `<iframe src={`${src}#toolbar=0&navpanes=0`} … style={{ aspectRatio: "1 / 1.4142" }} />` — die Werkzeugleiste des eingebauten Betrachters wird also **aktiv** ausgeblendet. Drei Aufrufer: `rechnungen/[id]/page.tsx:184`, `dokumente/[id]/page.tsx:153`, `lieferscheine/[id]/page.tsx`. Der Textrückfall („Wird das PDF nicht angezeigt: PDF öffnen") steht bereits darunter und bleibt.

**Interfaces:**
```ts
// src/components/detail/PdfViewToolbar.tsx
export function PdfViewToolbar({ src, title }: { src: string; title: string }): JSX.Element;
// Zustand "wide" in localStorage["oig.pdf.wide"] ("1"|"0"); Lesen erst in useEffect, damit
// Server-Render und erster Client-Render identisch bleiben (keine Hydration-Warnung).
```

- [ ] **Step 1: Failing test schreiben**

```tsx
// test/unit/pdf-stack.test.tsx
/** Phase 13c, Task 1 — die Werkzeugleiste des eingebauten Browser-Betrachters ist wieder
 *  frei (Ruling "Kein PDF.js"). Kein RTL: renderToStaticMarkup + Strukturtest ueber die
 *  Quelldatei (Muster charts.test.tsx / dialogs.test.ts). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PdfStack } from "@/components/detail/PdfStack";

const SRC = path.resolve(__dirname, "../../src");

describe("PdfStack (Phase 13c)", () => {
  it("blendet die Werkzeugleiste NICHT mehr aus und startet mit FitH", () => {
    const html = renderToStaticMarkup(<PdfStack src="/api/invoices/i1/pdf" title="Rechnung — PDF" />);
    expect(html).not.toContain("toolbar=0");
    expect(html).not.toContain("navpanes=0");
    expect(html).toContain("/api/invoices/i1/pdf#view=FitH");
    expect(html).toContain("In neuem Tab öffnen");
    expect(html).toContain("Herunterladen");
  });

  it("ohne src bleibt der Hinweis", () => {
    const html = renderToStaticMarkup(<PdfStack src={null} title="t" emptyText="Noch kein PDF." />);
    expect(html).toContain("Noch kein PDF.");
    expect(html).not.toContain("<iframe");
  });

  it("der Umschalter merkt sich den Zustand unter oig.pdf.wide", () => {
    const bar = readFileSync(path.join(SRC, "components/detail/PdfViewToolbar.tsx"), "utf8");
    expect(bar).toContain('"use client"');
    expect(bar).toContain("oig.pdf.wide");
    // Lesen erst im Effekt — sonst weicht der erste Client-Render vom Server-HTML ab.
    expect(bar).toMatch(/useEffect\([\s\S]*localStorage\.getItem/);
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/pdf-stack.test.tsx`.

- [ ] **Step 3: `PdfViewToolbar.tsx` schreiben**

```tsx
// src/components/detail/PdfViewToolbar.tsx
"use client";

import { useEffect, useState } from "react";

const KEY = "oig.pdf.wide";
const btn = "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50";

/**
 * Phase 13c (Ruling "Kein PDF.js"): Seitenzahl, Blaettern, Zoom, Suche und Drucken liefert
 * die Werkzeugleiste des eingebauten Browser-Betrachters — hier steht nur, was sie NICHT
 * kann: Rahmengroesse (schmal = A4-Verhaeltnis wie bisher, breit = volle Fensterhoehe),
 * "in neuem Tab", "herunterladen". Der Zustand liegt in localStorage und wird erst im
 * Effekt gelesen, damit Server-HTML und erster Client-Render identisch bleiben.
 */
export function PdfViewToolbar({ src, title }: { src: string; title: string }) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    // privater Modus / blockierter Speicher: Standard bleibt schmal
    try { setWide(window.localStorage.getItem(KEY) === "1"); } catch { /* ignorieren */ }
  }, []);

  function toggle() {
    setWide((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* nur Bequemlichkeit */ }
      return next;
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={toggle} className={btn} aria-pressed={wide}>
          {wide ? "Schmal" : "Breit"}
        </button>
        <a href={src} target="_blank" rel="noreferrer" className={btn}>
          In neuem Tab öffnen
        </a>
        <a href={src} download className={btn}>
          Herunterladen
        </a>
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100 shadow-sm">
        <iframe
          src={`${src}#view=FitH`}
          title={title}
          className={wide ? "block h-[calc(100dvh-13rem)] w-full" : "block w-full"}
          style={wide ? undefined : { aspectRatio: "1 / 1.4142" }}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `PdfStack.tsx` umbauen** — Leerzustand und Textrückfall bleiben wörtlich, der `<iframe>`-Block weicht `<PdfViewToolbar src={src} title={title} />`. Modulkommentar auf den neuen Stand bringen (Verweis auf das Ruling, kein eigener Betrachter).

- [ ] **Step 5: Gate + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(detail): PDF-Werkzeugleiste des Browsers wieder frei, Breit/Schmal-Umschalter

Phase 13c, Task 1. PdfStack laesst #toolbar=0&navpanes=0 fallen (#view=FitH); neue
Client-Komponente PdfViewToolbar (localStorage oig.pdf.wide, neuer Tab, Herunterladen).
Kein PDF.js, keine neue Abhaengigkeit."
```

---

### Task 2: Breiteres Detail-Raster, Kartenaufteilung der rechten Spalte

**Files:**
- Create: `src/components/detail/DetailCard.tsx`, `test/unit/detail-layout.test.tsx`
- Modify: `src/components/detail/DocumentDetailLayout.tsx`, `src/app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx`, `src/app/rechnungen/[id]/page.tsx`

**Befund (verifiziert):** `DocumentDetailLayout.tsx:43` ist `grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]`; `nav` steht in `:30` über dem Titel. `InvoiceStatusCard` baut **eine** `StatusCard` mit 8–12 Zeilen und hängt Zahlungsformular, Zahlungsliste, Mahnblock und die `children` darunter. `StatusCard` rendert Titel + Status-Chips + `dl`-Zeilen + `children` — bleibt unverändert und wird weiter benutzt.

**Interfaces:**
```ts
// src/components/detail/DetailCard.tsx
export function DetailCard({ title, action, children }: {
  title: string; action?: ReactNode; children: ReactNode;
}): JSX.Element;
```

- [ ] **Step 1: Failing test schreiben**

```tsx
// test/unit/detail-layout.test.tsx
/** Phase 13c, Task 2 — breiteres Raster, Belegkarte mit Nav, getrennte Karten. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentDetailLayout } from "@/components/detail/DocumentDetailLayout";
import { DetailCard } from "@/components/detail/DetailCard";

function render() {
  return renderToStaticMarkup(
    <DocumentDetailLayout
      nav={<span>NAV-MARKER</span>}
      title="Rechnung RE-1001"
      pdf={<span>PDF</span>}
      aside={<DetailCard title="Details">Inhalt</DetailCard>}
    >
      <span>UNTEN</span>
    </DocumentDetailLayout>,
  );
}

describe("DocumentDetailLayout (Phase 13c)", () => {
  it("nutzt das breitere xl-Raster mit 24rem-Spalte", () => {
    const html = render();
    expect(html).toContain("xl:grid-cols-[minmax(0,1fr)_24rem]");
    expect(html).not.toContain("lg:grid-cols-[minmax(0,1fr)_20rem]");
  });

  it("zeigt die Navigation in der Belegkarte, nicht mehr ueber dem Titel", () => {
    const html = render();
    const asideStart = html.indexOf("<aside");
    expect(asideStart).toBeGreaterThan(0);
    expect(html.indexOf("NAV-MARKER")).toBeGreaterThan(asideStart);
    expect(html).toContain("Beleg");
    expect(html).toContain("Rechnung RE-1001");
  });

  it("DetailCard rendert Titel und Inhalt", () => {
    expect(renderToStaticMarkup(<DetailCard title="Anhänge">X</DetailCard>)).toContain("Anhänge");
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/detail-layout.test.tsx`.

- [ ] **Step 3: `DetailCard.tsx` + Layout**

```tsx
// src/components/detail/DetailCard.tsx
import type { ReactNode } from "react";

/** Titelnder Kartenrahmen der rechten Spalte (Phase 13c) — dasselbe Aeussere wie
 *  `StatusCard`, nur ohne Zeilenliste: fuer Beleg/Anhaenge/Dokumentenkette. */
export function DetailCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
```

In `DocumentDetailLayout.tsx`: `nav` aus dem Kopfblock entfernen, Raster auf `grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]`, und der `aside` beginnt mit der Belegkarte:

```tsx
<aside className="space-y-4">
  <DetailCard title="Beleg">
    <p className="font-medium text-slate-900">{title}</p>
    {nav}
  </DetailCard>
  {aside}
</aside>
```

- [ ] **Step 4: `InvoiceStatusCard` aufteilen** — aus einer Karte werden zwei, die Reihenfolge der Zeilen folgt der Spec:
  - **„Kunde & Betrag"** (`StatusCard` mit `status`-Chips): Kunde (Link), Anschrift, Rechnungsdatum, Brutto — Brutto als `text-base font-semibold`, plus Bezahlt/Offen, solange `showPaymentBlock`.
  - **„Details"** (`StatusCard title="Details"` ohne `status`): relative Fälligkeit (`relativeDueLabel(invoice.dueDate, new Date())` aus 13a, mit `title` = absolutes Datum), Leistungsdatum, Zahlungsziel/Zahlungsmethode, Steuerschema, USt-IdNr., Skonto, E-Rechnung-Badge (`invoice.xmlFormat != null`), „festgeschrieben am" (`invoice.finalizedAt`).
  - Zahlungsliste und Mahnblock (`PaymentSection`) bleiben **unverändert** und wandern unter die „Details"-Karte; das Zahlungs**formular** verschwindet hier (Task 3). Die `children` (AttachmentPanel, DocumentChain) hüllt der Aufrufer in eigene `DetailCard`s („Anhänge", „Dokumentenkette").

- [ ] **Step 5: Gate + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(detail): breiteres Raster und getrennte Karten in der rechten Spalte

Phase 13c, Task 2. Layout auf xl:grid-cols-[minmax(0,1fr)_24rem]; DetailNav in einer
neuen Belegkarte, Statuskarte zerfaellt in 'Kunde & Betrag' und 'Details' (relative
Faelligkeit aus 13a). Neuer Baustein DetailCard, StatusCard unveraendert genutzt."
```

---

### Task 3: Zahlung als Dialog (Anker `#zahlung` bleibt gültig)

**Files:**
- Create: `src/app/rechnungen/[id]/_parts/PaymentDialog.tsx`, `test/unit/payment-dialog.test.ts`
- Modify: `src/components/PaymentForm.tsx`, `src/app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx`, `src/app/rechnungen/[id]/page.tsx`

**Befund (verifiziert, weicht von der Spec-Benennung ab):** Die Spec nennt „`PaymentSection` wandert in einen `<dialog>`". Im Code ist `PaymentSection.tsx` der **Mahnblock**; das Zahlungsformular ist `PaymentForm` (`src/components/PaymentForm.tsx`), eingebettet in `InvoiceStatusCard.tsx:117` in `<div id="zahlung"><CollapsibleSection title="Zahlung erfassen" …><PaymentForm …/></CollapsibleSection></div>`. **Also wandert `PaymentForm` in den Dialog, `PaymentSection` (Mahnwesen) bleibt, wo es ist.** `PaymentForm` postet auf `POST /api/invoices/[id]/payment` und ruft danach `router.refresh()` — beides bleibt unverändert; ergänzt wird nur ein optionales `onDone`, damit der Dialog sich schließt. Dialog-Muster: `src/components/dunning/PauseDialog.tsx` (`useRef<HTMLDialogElement>`, `showModal()`, `close()`), Zentrierung über die `dialog:modal`-Regel in `globals.css` (Phase 12a) — jeder `<dialog>` **muss** `w-full` + eine `max-w-*`-Klasse tragen, sonst schlägt `test/unit/dialogs.test.ts` fehl.

**Interfaces:**
```ts
// src/app/rechnungen/[id]/_parts/PaymentDialog.tsx
export function PaymentDialog(props: {
  invoiceId: string; openCents: number; methods: { code: string; name: string }[]; defaultMethod: string;
  /** Beschriftung des oeffnenden Knopfes (Kopfzeile: "Als bezahlt markieren"). */
  label?: string;
  /** true: als Menuezeile statt als Knopf rendern (ActionMenuItem). */
  asMenuItem?: boolean;
}): JSX.Element;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/payment-dialog.test.ts
/** Phase 13c, Task 3 — Strukturtest (kein RTL): der Zahlungsdialog nutzt dasselbe
 *  PaymentForm und dieselbe Route, oeffnet sich ueber den Anker #zahlung und traegt die
 *  Breitenklassen, die die Phase-12a-Dialogregel verlangt. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
const dialog = readFileSync(path.join(SRC, "app/rechnungen/[id]/_parts/PaymentDialog.tsx"), "utf8");
const card = readFileSync(path.join(SRC, "app/rechnungen/[id]/_parts/InvoiceStatusCard.tsx"), "utf8");
const form = readFileSync(path.join(SRC, "components/PaymentForm.tsx"), "utf8");

describe("Zahlungsdialog (Phase 13c)", () => {
  it("bettet das unveraenderte PaymentForm ein — keine eigene Buchungslogik", () => {
    expect(dialog).toContain("PaymentForm");
    expect(dialog).not.toMatch(/fetch\(/);
    expect(form).toMatch(/\/api\/invoices\/\$\{invoiceId\}\/payment/);
  });

  it("der Anker #zahlung oeffnet den Dialog (Bestandslinks aus Liste und Mahnwesen)", () => {
    expect(dialog).toContain("hashchange");
    expect(dialog).toContain('id="zahlung"');
  });

  it("traegt w-full und eine max-w-Klasse (dialogs.test.ts-Regel)", () => {
    expect(dialog).toMatch(/<dialog[\s\S]{0,400}?w-full[\s\S]{0,200}?max-w-/);
  });

  it("die Statuskarte zeigt kein Dauerformular mehr", () => {
    expect(card).not.toContain("<PaymentForm");
    expect(card).toContain("PaymentDialog");
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/payment-dialog.test.ts`.

- [ ] **Step 3: `PaymentDialog.tsx` schreiben**

```tsx
// src/app/rechnungen/[id]/_parts/PaymentDialog.tsx
"use client";

import { useEffect, useRef } from "react";
import { PaymentForm } from "@/components/PaymentForm";
import { formatCents } from "@/lib/money";

/**
 * Phase 13c: die Zahlungserfassung sitzt nicht mehr als Dauerformular in der rechten
 * Spalte, sondern in einem modalen Dialog — dasselbe `PaymentForm`, dieselbe Route
 * (POST /api/invoices/[id]/payment), derselbe Domain-Pfad (recordPayment). Der Anker
 * `#zahlung` bleibt gueltig: jeder Bestandslink aus Liste, Mahnwesen und Kopfzeile
 * oeffnet den Dialog (beim Laden mit gesetztem Hash und bei jedem `hashchange`).
 * Ruling: "Als bezahlt markieren" bucht NIE still — vorbelegt (Offenbetrag, heutiges
 * Datum, Standardmethode; macht `PaymentForm` bereits), gebucht wird erst auf Klick.
 */
export function PaymentDialog({
  invoiceId,
  openCents,
  methods,
  defaultMethod,
  label = "Zahlung erfassen",
  asMenuItem = false,
}: {
  invoiceId: string;
  openCents: number;
  methods: { code: string; name: string }[];
  defaultMethod: string;
  label?: string;
  asMenuItem?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    function openIfAnchored() {
      if (window.location.hash === "#zahlung" && !ref.current?.open) ref.current?.showModal();
    }
    openIfAnchored();
    window.addEventListener("hashchange", openIfAnchored);
    return () => window.removeEventListener("hashchange", openIfAnchored);
  }, []);

  function close() {
    ref.current?.close();
    // Hash zuruecksetzen, sonst oeffnet ein erneuter Klick auf denselben Anker nicht mehr
    // (der Hash aendert sich dann nicht und `hashchange` feuert nicht).
    if (window.location.hash === "#zahlung") history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  const trigger = asMenuItem ? "block w-full px-3 py-1.5 text-left hover:bg-slate-50" : "rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700";

  return (
    <>
      {/* Anker-Ziel: Bestandslinks (#zahlung) springen hierher UND oeffnen den Dialog. */}
      <span id="zahlung" />
      <button type="button" onClick={() => ref.current?.showModal()} className={trigger}>
        {label}
      </button>
      <dialog ref={ref} className="w-full max-w-2xl rounded-lg border border-slate-200 p-5 backdrop:bg-slate-900/40">
        <h2 className="mb-1 text-base font-semibold text-slate-900">Zahlung erfassen</h2>
        <p className="mb-3 text-sm text-slate-500">Offen: {formatCents(openCents)}</p>
        <PaymentForm invoiceId={invoiceId} openCents={openCents} methods={methods} defaultMethod={defaultMethod} onDone={close} />
        <div className="mt-3 text-right">
          <button type="button" onClick={close} className="text-sm text-slate-500 hover:text-slate-800">Schließen</button>
        </div>
      </dialog>
    </>
  );
}
```

- [ ] **Step 4: `PaymentForm` um `onDone` ergänzen** — Signatur `onDone?: () => void`, im Erfolgsfall **nach** `router.refresh()` aufrufen; sonst keine Zeile ändern (Skonto-Vorschau, Fehlerpfad, „Rest"-Knopf bleiben wörtlich). In `InvoiceStatusCard` den `#zahlung`-Block (`CollapsibleSection` + `PaymentForm`) durch `{canPay && <PaymentDialog … />}` ersetzen; die Zahlungsliste darunter bleibt.

- [ ] **Step 5: Gate + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(rechnungen): Zahlungserfassung als Dialog statt Dauerformular

Phase 13c, Task 3. PaymentDialog um das unveraenderte PaymentForm; gleiche Route und
gleicher Domain-Pfad. Anker #zahlung oeffnet den Dialog. Kein stilles Buchen."
```

---

### Task 4: Primäraktion je Status + Kopfzeile „Neue Rechnung"

**Files:**
- Create: `test/unit/invoice-primary-action.test.ts`
- Modify: `src/app/rechnungen/[id]/_parts/invoice-view-model.ts`, `src/app/rechnungen/[id]/page.tsx`

**Befund (verifiziert):** Die Kopfzeile (`page.tsx:139-163`) zeigt heute bis zu fünf gleichwertige Knöpfe (PDF, E-Mail, Bearbeiten, Festschreiben, Zahlung erfassen). `buildInvoiceViewModel` liefert bereits `isDraft`, `isCancelled`, `canPay`, `isInvoiceType` und `actions` (aus `availableActions`) — die Primäraktion ist daraus **ableitbar**, ohne DB-Zugriff und ohne zweite Aktionsmatrix.

**Interfaces:**
```ts
// src/app/rechnungen/[id]/_parts/invoice-view-model.ts
export type PrimaryActionKind = "FINALIZE" | "PAY" | "NEW_INVOICE";
export interface PrimaryAction { kind: PrimaryActionKind; label: string }
export function primaryAction(vm: Pick<InvoiceViewModel, "isDraft" | "isCancelled" | "canPay" | "isInvoiceType">): PrimaryAction;
```

- [ ] **Step 1: Failing test schreiben**

```ts
// test/unit/invoice-primary-action.test.ts
/** Phase 13c, Task 4 — Primaeraktion je Status als reine Tabelle (kein DB-Zugriff). */
import { describe, it, expect } from "vitest";
import { primaryAction } from "@/app/rechnungen/[id]/_parts/invoice-view-model";

const base = { isDraft: false, isCancelled: false, canPay: false, isInvoiceType: true };

describe("primaryAction", () => {
  it("Entwurf -> Festschreiben (schlaegt alles andere)", () => {
    expect(primaryAction({ ...base, isDraft: true })).toEqual({ kind: "FINALIZE", label: "Festschreiben" });
    expect(primaryAction({ isDraft: true, isCancelled: true, canPay: true, isInvoiceType: true }).kind).toBe("FINALIZE");
  });
  it("festgeschrieben/versendet/teilbezahlt (offen) -> Als bezahlt markieren", () => {
    expect(primaryAction({ ...base, canPay: true })).toEqual({ kind: "PAY", label: "Als bezahlt markieren" });
  });
  it("bezahlt -> Neue Rechnung", () => {
    expect(primaryAction(base)).toEqual({ kind: "NEW_INVOICE", label: "Neue Rechnung" });
  });
  it("storniert und Gutschrift -> Neue Rechnung, nie Zahlung", () => {
    expect(primaryAction({ ...base, isCancelled: true, canPay: true }).kind).toBe("NEW_INVOICE");
    expect(primaryAction({ ...base, isInvoiceType: false, canPay: true }).kind).toBe("NEW_INVOICE");
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/invoice-primary-action.test.ts`.

- [ ] **Step 3: `primaryAction` implementieren**

```ts
/**
 * Phase 13c: genau EINE hervorgehobene Aktion je Status (Spec C). Reine Ableitung aus
 * dem bereits berechneten View-Model — KEINE zweite Aktionsmatrix neben availableActions
 * (§41): `canPay` stammt selbst aus `!isDraft && !isCancelled && isInvoiceType &&
 * openCents > 0`. "Als bezahlt markieren" oeffnet den vorbelegten Zahlungsdialog
 * (Ruling: nie stilles Buchen).
 */
export function primaryAction(vm: Pick<InvoiceViewModel, "isDraft" | "isCancelled" | "canPay" | "isInvoiceType">): PrimaryAction {
  if (vm.isDraft) return { kind: "FINALIZE", label: "Festschreiben" };
  if (!vm.isCancelled && vm.isInvoiceType && vm.canPay) return { kind: "PAY", label: "Als bezahlt markieren" };
  return { kind: "NEW_INVOICE", label: "Neue Rechnung" };
}
```

- [ ] **Step 4: Kopfzeile umbauen (`page.tsx`)** — `actions`-Slot wird: Primäraktion (indigo) + die sekundären Knöpfe als schlichte Rahmenknöpfe.
  - `FINALIZE` → bestehendes `<form action={finalizeAction}>` (unverändert). `PAY` → `<PaymentDialog … label="Als bezahlt markieren" />` mit `openCents={vm.openCents}`, `methods={activePaymentMethods…}`, `defaultMethod={defaultPaymentMethodCode}` (dieselben Werte, die heute an `InvoiceStatusCard` gehen). `NEW_INVOICE` → `<Link href={`/rechnungen/neu?customerId=${invoice.customer.id}`}>`.
  - Zusätzlich **immer** ein sekundärer „Neue Rechnung"-Link, außer er ist bereits die Primäraktion. PDF, `SendEmailDialog`, „Bearbeiten" bleiben sekundäre Knöpfe; `InvoiceMoreMenu` unverändert.
  - **Prüfen:** `/rechnungen/neu` muss `?customerId=` bereits auswerten (`src/app/rechnungen/neu/page.tsx`). Tut es das nicht, wird der Parameter in **diesem** Task ergänzt (Vorbelegung des Empfängers im Editor-Draft) — kein Link ins Leere (DoD „keine Attrappe").

- [ ] **Step 5: Gate + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test
git add -A && git commit -s -m "feat(rechnungen): eine Primaeraktion je Status auf der Belegseite

Phase 13c, Task 4. primaryAction() im View-Model (reine Funktion, Tabellentest):
Entwurf -> Festschreiben, offen -> Als bezahlt markieren (vorbelegter Dialog),
bezahlt/storniert -> Neue Rechnung; Kopfzeile zusaetzlich mit 'Neue Rechnung'."
```

---

### Task 5: Angebots-Menü über `availableActions`, Lieferschein-/Dokumentkarten, Doku, Smoke

**Files:**
- Modify: `src/app/dokumente/[id]/page.tsx`, `src/app/dokumente/[id]/_parts/DocumentStatusCard.tsx`, `src/app/lieferscheine/[id]/page.tsx`, `src/app/lieferscheine/[id]/_parts/DeliveryNoteStatusCard.tsx`, `src/domain/document/actions.ts` (nur falls die 13a-Keys die Bestandsbedingungen nicht decken), `test/unit/document-actions.test.ts`, `docs/LIMITATIONEN.md`, `docs/ANLEITUNG.md`, `docs/ARCHITEKTUR.md`

**Befund (verifiziert):** `dokumente/[id]/page.tsx:48-51` hält **vier** client-seitige Statuskopien (`ANGEBOT_TO_AB_STATUSES`, `ANGEBOT_TO_INVOICE_STATUSES`, `AB_TO_INVOICE_STATUSES`, `QUOTE_TO_DELIVERY_NOTE_STATUSES`) neben `availableActions`. „Auftrag erhalten"/„Auftrag abgelehnt" existieren bereits als `MARK_ACCEPTED`/`MARK_REJECTED` in `useDocumentActions` (`src/components/DocumentActions.tsx:12-19`, POST `/api/documents/[id]/status`) — es gibt **keine** Server-Action `setQuoteStatus`, die Spec-Formulierung meint diesen Pfad. `lieferscheine/[id]` hält analog `DELIVERY_NOTE_PARTIAL_INVOICE_STATUSES`.

- [ ] **Step 1: Failing test schreiben** — `test/unit/document-actions.test.ts` (Bestandsdatei) um einen Block erweitern:

```ts
describe("Angebotsaktionen (Phase 13c)", () => {
  const quote = (status: string, extra: Partial<ActionableDoc> = {}): ActionKey[] =>
    availableActions({ kind: "QUOTE", type: "ANGEBOT", status, isDraft: status === "DRAFT", ...extra });

  it("QUOTE_ACCEPT/QUOTE_REJECT nur solange offen", () => {
    expect(quote("SENT")).toEqual(expect.arrayContaining(["QUOTE_ACCEPT", "QUOTE_REJECT"]));
    expect(quote("ACCEPTED")).not.toContain("QUOTE_ACCEPT");
    expect(quote("REJECTED")).not.toContain("QUOTE_REJECT");
  });

  it("DELIVERY_NOTE_CREATE/CONVERT decken genau die Statuszustaende der Bestandsseite ab", () => {
    // QUOTE_TO_DELIVERY_NOTE_STATUSES (dokumente/[id]/page.tsx vor 13c): DRAFT|SENT|ACCEPTED|EXPIRED
    for (const s of ["DRAFT", "SENT", "ACCEPTED", "EXPIRED"]) expect(quote(s)).toContain("DELIVERY_NOTE_CREATE");
    for (const s of ["CANCELLED", "REJECTED"]) expect(quote(s)).not.toContain("DELIVERY_NOTE_CREATE");
    expect(quote("SENT")).toContain("CONVERT");
    expect(quote("CANCELLED")).not.toContain("CONVERT");
  });
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/document-actions.test.ts`. Läuft der Block bereits grün (13a hat die Keys passend gesetzt), **entfällt Step 3**; andernfalls `src/domain/document/actions.ts` in `quoteActions` nachziehen (nur Sichtbarkeit, keine Berechtigung — die bleibt serverseitig, 409 bei Verstoß).

- [ ] **Step 3: `dokumente/[id]/page.tsx` auf `availableActions` umstellen**

```tsx
const actions = availableActions({
  kind: "QUOTE",
  type: q.kind,
  status,
  isDraft: status === "DRAFT",
});
// …
showToDeliveryNote={actions.includes("DELIVERY_NOTE_CREATE")}
```
Die vier lokalen `Set`s entfallen bis auf die beiden, die eine **fachliche Zusatzregel** tragen, die `availableActions` nicht kennt (`ANGEBOT_TO_AB_STATUSES`/`AB_TO_INVOICE_STATUSES` — Konvertierungsziel je `kind`); diese bleiben mit unverändertem Kommentar stehen, werden aber zusätzlich an `actions.includes("CONVERT")` gehängt, damit ein stornierter/abgelehnter Beleg keinen Konvertierungseinstieg mehr zeigt. „Auftrag erhalten"/„Auftrag abgelehnt" stehen über `DocumentActionsMenuItems` bereits im Menü — zusätzlich wird der jeweils **erste** verfügbare Übergang wie bisher über `DocumentActions variant="compact"` als Knopf gezeigt (unverändert). Der Menüpunkt „Als Vorlage speichern" wird **hier vorbereitet, aber nicht gerendert** (`TEMPLATE_SAVE` bleibt bis 13d ohne Backend — DoD „keine Attrappe").

- [ ] **Step 4: Karten auf Dokument-/Lieferscheinseite angleichen** — `DocumentStatusCard`/`DeliveryNoteStatusCard` behalten ihre Zeilen, bekommen aber dieselbe Zweiteilung („Kunde & Betrag" / „Details"), und die `children` (ShareLinkPanel, AttachmentPanel, DocumentChain, PrintOptionsPanel) werden in `DetailCard`s gehüllt. `NavHint`, `InternalNotesBox`, Positionen, E-Mail-Verlauf und Zeitstrahl bleiben unter der Vorschau (Phase-11d-Bestand, ausdrücklich behalten).

- [ ] **Step 5: Doku**
  - `docs/LIMITATIONEN.md`, Abschnitt „Belegansicht": den Satz „PDF-Ansicht nutzt den Browser-Viewer" fortschreiben — **Bedienung** (Seitenzahl, Blättern, Zoom, Drucken) hängt jetzt vollständig vom eingebauten Betrachter ab, es gibt bewusst keinen eigenen; auf iOS/Safari und in WebViews bleibt nur der Rückfall-Link. Breit/Schmal ist eine reine Anzeigeeinstellung im Browser (`localStorage`), nicht am Beleg gespeichert, nicht geräteübergreifend.
  - `docs/ANLEITUNG.md`: Kurzabschnitt „Belegseite" (Primäraktion, Zahlungsdialog, Breit/Schmal). `docs/ARCHITEKTUR.md`: `PdfViewToolbar`/`DetailCard` in der Komponentenübersicht der Belegdetailseiten ergänzen.

- [ ] **Step 6: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots einzeln nach `<scratchpad>/ui-previews/13c-*.png`):
  1. Rechnung mit offenem Betrag öffnen → PDF-Werkzeugleiste sichtbar und bedienbar (Seite vor/zurück, Zoom); „Breit" klicken → Rahmen wächst, Seite neu laden → Zustand bleibt.
  2. `/rechnungen/<id>#zahlung` direkt aufrufen → Dialog öffnet sich vorbelegt; schließen; „Als bezahlt markieren" → derselbe Dialog; buchen → Status wechselt.
  3. Angebot öffnen → Mehr-Menü zeigt Annehmen/Ablehnen, Konvertierungen, Lieferschein; storniertes Angebot zeigt keinen Konvertierungseinstieg.

- [ ] **Step 7: Gesamtprüfung + Commit**

```bash
npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung
git add -A && git commit -s -m "feat(dokumente): Angebotsmenue ueber availableActions, Kartenaufteilung, Doku

Phase 13c, Task 5. /dokumente/[id] leitet Lieferschein-/Konvertierungseinstiege aus
availableActions ab statt aus Statuskopien; Dokument- und Lieferscheinseite bekommen
dieselbe Kartenaufteilung. LIMITATIONEN/ANLEITUNG/ARCHITEKTUR fortgeschrieben."
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. **Kein zweiter Weg:** `availableActions` bleibt die einzige Aktionsmatrix; auf `/dokumente/[id]` steht keine Statuskopie mehr, die sie bereits abdeckt. Kein zweites Zahlungsformular, keine zweite Buchungsroute.
2. **Geld:** `PaymentForm` bis auf `onDone` unverändert; `recordPayment`/`detectSkonto`/`/skonto-check` nicht angefasst (`git diff --stat src/domain/invoice` leer). „Als bezahlt markieren" bucht nie ohne Klick auf „Buchen".
3. **Anker/Dialog:** Jeder Bestandslink auf `#zahlung` öffnet den Dialog — auch beim zweiten Klick (Hash wird beim Schließen zurückgesetzt); `test/unit/dialogs.test.ts` grün (`w-full max-w-2xl`).
4. **PDF:** Kein `toolbar=0`/`navpanes=0` mehr im Quellbaum, keine neue Abhängigkeit in `package.json`, Textrückfall („PDF öffnen") auf allen drei Seiten vorhanden.
5. **GoBD/§48/keine Attrappe:** Kein neuer Schreibpfad, `src/lib/db.ts` unverändert, interne Notizen nur in `InternalNotesBox`; Breit/Schmal, „In neuem Tab", „Herunterladen", Primäraktion und „Neue Rechnung" haben je eine echte Wirkung; `TEMPLATE_SAVE` wird in 13c **nicht** gerendert.
6. **Querschnitt:** `typecheck`, `lint`, `TZ=UTC npm test` (Bestandstests grün), `build`, `validate:erechnung`. Keine Migration, kein Postgres-Lauf nötig.
