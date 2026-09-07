# Phase 11c — Gemeinsamer Beleg-Editor nach sevDesk-Aufbau — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein gemeinsamer, ruhiger Beleg-Editor für Rechnung/Gutschrift, Angebot/Auftragsbestätigung/Proforma und Lieferschein ersetzt die drei heutigen Formulare: fixe Kopfzeile mit Vorschau und Speichern, Empfänger und Belegdaten nebeneinander, Kopftext, Positionstabelle mit Produktsuche in der Zeile, Fußtext, „Weitere Optionen" eingeklappt, Anhänge. Rechnungen sollen sich damit so leicht schreiben lassen wie bei sevDesk.

**Architecture:** Der Editor ist reine UI-Schicht auf dem bestehenden Backend: dieselben Zod-Schemas (`createInvoiceSchema`, `updateInvoiceSchema`, `createDocumentSchema`, `updateDocumentSchema`, `createDeliveryNoteSchema`) und dieselben Routen (`POST/PATCH /api/invoices`, `/api/documents`, `POST /api/delivery-notes`). Ein rahmenloser Entwurfszustand (`DraftState`, Reducer, reine Payload-Mapper in `src/lib/editor/`) wird von einer `DocumentEditor`-Komponente mit kleinen Blöcken gerendert; ein `EditorMode` (INVOICE | DOCUMENT | DELIVERY_NOTE) schaltet Felder und Payload-Mapper. Neu im Backend nur: `POST /api/pdf/preview` (rendert den ungespeicherten Entwurf über die vorhandenen Renderer) und eine kleine Server-Action `createCustomerInline` (Kunde anlegen ohne Seitenwechsel), beide mit denselben Zod-Schemas wie UI und MCP.

**Tech Stack:** Next.js App Router (Client-Komponenten für den Editor, Server-Komponenten für Seiten), React `useReducer`, Zod, Vitest, pdfkit-Renderer aus Phase 11b.

**Spec:** `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md` (Branch `specs`), Abschnitt 2 „Editor", „Vorschau im Editor", Abschnitte 3, 4, 5 (11c), 6.

## Global Constraints

- TypeScript strict, kein `any`; `unknown` + Narrowing. Dateien kebab-case, Komponenten PascalCase, Konstanten UPPER_SNAKE_CASE.
- Zod an jeder Boundary: der Editor sendet exakt die heutigen Payloads (`createInvoiceSchema`/`updateInvoiceSchema`/`createDocumentSchema`/`updateDocumentSchema`/`createDeliveryNoteSchema`); `POST /api/pdf/preview` validiert mit denselben Schemas; `createCustomerInline` mit `customerSchema`.
- Geld als Integer-Cent, Mengen Integer-Milliunits, Rabatte Permille — Umrechnung ausschließlich über `parseEuroToCents`/`parseQuantityToMilli` aus `src/lib/money.ts` und die neuen Helfer in `src/lib/editor/parse.ts`; keine Floats im Zustand, der an den Server geht.
- Keine neue Abhängigkeit. Kein Editor-Framework: `RichTextField` bleibt.
- GoBD: Bearbeiten nur im Entwurf (Seiten leiten wie heute bei `status !== "DRAFT"` um); der Editor ruft nie Domain-Funktionen direkt, nur die Routen; `internalNotes` erscheinen nie in der Vorschau (Preview-Route reicht sie nicht an den Renderer).
- Vorschau: `POST /api/pdf/preview` schreibt nichts (Test zählt DB-Zeilen vorher/nachher), Nummer „ENTWURF", Wasserzeichen „VORSCHAU" auf jeder Seite, `cache-control: no-store`.
- Bestehende Tests bleiben grün; `TZ=UTC npm test`, `npm run build`, `npm run validate:erechnung`, `npm run api:check` vor dem Abschluss.
- Jeder Commit `git commit -s` (DCO) auf Branch `phase-11c/editor` aus Fork-`main`.
- Testjahr dieser Phase: **2074** (Nummernkreis-Präfix `ED74-` bei Festschreibungen, Muster `test/integration/customer-routes.test.ts:71`).
- Abgrenzung: `PartialCreditForm` (Teilgutschrift) bleibt eigenständig; Lieferschein-Bearbeitung existiert im Backend nicht (nur Anlage) und wird hier nicht ergänzt (LIMITATIONEN); Live-PDF beim Tippen nur auf Knopfdruck.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/lib/editor/constants.ts` | `LINE_TYPE_LABEL`, `TAX_RATE_OPTIONS`, `SCHEME_CATEGORY`, `SCHEME_NOTICE`, `UNIT_OPTIONS` (C62 Stk, HUR Std, DAY Tag, KGM kg, MTR m, LTR l, MTK m², H87 Stück-Pauschale), `EDITOR_MODES` |
| `src/lib/editor/parse.ts` | `toCents`, `toMilli`, `toPermille`, `fromCents`, `fromMilli` (Anzeige) — auf `money.ts` aufgesetzt, ersetzt die drei duplizierten Helfer |
| `src/lib/editor/draft.ts` | `DraftState`, `DraftLine`, `EditorMode`, `draftReducer`, `emptyDraft(mode)`, `draftFromInvoice(initial)`, `draftFromDocument(initial)`, `toInvoicePayload(draft, isEdit)`, `toDocumentPayload(draft, isEdit)`, `toDeliveryNotePayload(draft)` |
| `src/lib/editor/totals.ts` | `computeDraftTotals(draft): DraftTotals` — extrahiert aus `NewInvoiceForm` (mit `isRegular`) |
| `src/app/api/pdf/preview/route.ts` | Vorschau-Route für ungespeicherte Entwürfe |
| `src/domain/settings/preview-draft.ts` | `buildDraftPreview(orgId, body)`: Payload → `EInvoiceData`/`DeliveryNotePdfData` + Theme → Buffer |
| `src/lib/pdf/theme.ts`, Engines | `PdfTheme.watermark?: string`, `drawWatermark` in `marks.ts`, je Seite |
| `src/app/actions/masterdata.ts` | `createCustomerInline(input)` |
| `src/components/editor/CustomerPicker.tsx`, `NewCustomerDialog.tsx` | Kundensuche mit Inline-Anlage |
| `src/components/editor/TextTemplatePicker.tsx` | Auswahl einer Textvorlage je Position (HEAD/FOOT/TERMS_DELIVERY/TERMS_PAYMENT) |
| `src/components/editor/DocumentEditor.tsx` | Rahmen: Reducer, Mode, Speichern, Vorschau, Unsaved-Guard |
| `src/components/editor/blocks/{EditorHeader,RecipientBlock,MetaBlock,HeadTextBlock,LineItemsEditor,LineRow,TotalsBlock,FootTextBlock,MoreOptions,AttachmentsBlock,PreviewSheet}.tsx` | die Blöcke |
| `src/components/editor/EditorField.tsx` | kleine Feld-Wrapper (Label + Input) auf `inputCls` aus `src/components/forms/fields.tsx` |
| Seiten `src/app/rechnungen/neu`, `rechnungen/[id]/bearbeiten`, `dokumente/neu`, `dokumente/[id]/bearbeiten`, `lieferscheine/neu` | nutzen `DocumentEditor` + `PageHeader` |
| Entfernt | `src/components/NewInvoiceForm.tsx`, `NewDocumentForm.tsx`, `DeliveryNoteForm.tsx` |
| Tests | `test/unit/editor-draft.test.ts`, `test/unit/editor-totals.test.ts`, `test/unit/editor-parse.test.ts`, `test/integration/pdf-preview-route.test.ts`, `test/integration/customer-inline-action.test.ts` |

---

### Task 1: Editor-Modell — Konstanten, Parser, Entwurfszustand, Payload-Mapper, Summen

**Files:**
- Create: `src/lib/editor/constants.ts`, `src/lib/editor/parse.ts`, `src/lib/editor/draft.ts`, `src/lib/editor/totals.ts`
- Test: `test/unit/editor-parse.test.ts`, `test/unit/editor-draft.test.ts`, `test/unit/editor-totals.test.ts`

**Interfaces (Produces):**
```ts
// constants.ts
export type EditorMode = "INVOICE" | "DOCUMENT" | "DELIVERY_NOTE";
export const LINE_TYPE_LABEL: Record<"ITEM"|"HEADING"|"TEXT"|"SUBTOTAL", string>;
export const TAX_RATE_OPTIONS: readonly { value: 19|7|0; label: string }[];
export const UNIT_OPTIONS: readonly { code: string; label: string }[]; // C62 "Stk" zuerst
export const SCHEME_CATEGORY: Record<TaxScheme, TaxCategory>; export const SCHEME_NOTICE: Partial<Record<TaxScheme, string>>;
// parse.ts
export function toCents(input: string): number | null; export function toMilli(input: string): number | null; export function toPermille(percent: string): number | null;
export function fromCents(cents: number): string /* "12,50" */; export function fromMilli(milli: number): string /* "2" oder "2,5" */; export function fromPermille(p: number): string;
// draft.ts
export interface DraftLine { key: string; lineType: "ITEM"|"HEADING"|"TEXT"|"SUBTOTAL"; description: string; descriptionLong: string; articleNumber: string; quantity: string; unit: string; price: string; taxRate: 19|7|0; discountPercent: string; discountAmount: string; productId?: string | null; expanded: boolean }
export interface DraftState { mode: EditorMode; id?: string; kind: "ANGEBOT"|"AUFTRAGSBESTAETIGUNG"|"PROFORMA"; type: "INVOICE"|"CREDIT_NOTE"; customerId: string; taxScheme: TaxScheme; subject: string; headerText: string; footerText: string; deliveryTerms: string; paymentTerms: string; notes: string; internalNotes: string; orderNumber: string; customerReference: string; internalReference: string; buyerReference: string; contactPersonId: string; billingAddressId: string; shippingAddressId: string; deliveryDate: string; deliveryStart: string; deliveryEnd: string; dueDate: string; validUntil: string; shippingDate: string; paymentMethodId: string; documentDiscountPercent: string; documentDiscountAmount: string; documentChargePercent: string; documentChargeAmount: string; documentChargeReason: string; skonto1Percent: string; skonto1Days: string; skonto2Percent: string; skonto2Days: string; showPrices: boolean; showTax: boolean; showArticleNumber: boolean; showDescription: boolean; showDeliveryAddress: boolean; lines: DraftLine[]; grossDisplay: boolean; dirty: boolean }
export type DraftAction = { type: "set"; field: keyof DraftState; value: unknown } | { type: "setLine"; key: string; patch: Partial<DraftLine> } | { type: "addLine"; lineType: DraftLine["lineType"]; after?: string } | { type: "removeLine"; key: string } | { type: "moveLine"; key: string; to: number } | { type: "duplicateLine"; key: string } | { type: "applyProduct"; key: string; product: { id: string; name: string; unit: string; netPriceCents: number; taxRate: number; articleNumber?: string | null } } | { type: "replace"; state: DraftState } | { type: "markSaved" };
export function draftReducer(state: DraftState, action: DraftAction): DraftState;
export function emptyDraft(mode: EditorMode, defaults?: Partial<DraftState>): DraftState;
export function draftFromInvoice(initial: InvoiceInitialLike): DraftState; export function draftFromDocument(initial: DocumentInitialLike): DraftState;
export function toInvoicePayload(d: DraftState, isEdit: boolean): Record<string, unknown>; // exakt das heutige `shared`-Objekt aus NewInvoiceForm.submit (+ type bei Neuanlage)
export function toDocumentPayload(d: DraftState, isEdit: boolean): Record<string, unknown>; // exakt NewDocumentForm.submit
export function toDeliveryNotePayload(d: DraftState): Record<string, unknown>; // exakt DeliveryNoteForm.submit
export function validateDraft(d: DraftState): string[]; // clientseitige Vorprüfung: Kunde gewählt, ≥1 Position, ITEM mit Menge ≠ 0, Preis parsebar
// totals.ts
export interface DraftTotals { lineNetCents: number; allowanceCents: number; chargeCents: number; netCents: number; taxRows: { rate: number; taxCents: number; baseCents: number }[]; taxCents: number; grossCents: number; subtotals: number[]; error: string | null }
export function computeDraftTotals(d: DraftState): DraftTotals;
```
`InvoiceInitialLike`/`DocumentInitialLike` = die heutigen `InvoiceInitial`/`DocumentInitial`-Formen aus den Seiten (Felder siehe Kontext §1); die Seiten in Task 6 bauen sie unverändert weiter.

- [ ] **Step 1: Failing tests**

```ts
// test/unit/editor-parse.test.ts
import { describe, it, expect } from "vitest";
import { toCents, toMilli, toPermille, fromCents, fromMilli, fromPermille } from "@/lib/editor/parse";
describe("editor/parse", () => {
  it("Euro-Eingaben mit Komma/Punkt/Tausenderpunkt", () => {
    expect(toCents("12,50")).toBe(1250); expect(toCents("12.50")).toBe(1250); expect(toCents("1.234,56")).toBe(123456);
    expect(toCents("")).toBeNull(); expect(toCents("abc")).toBeNull(); expect(toCents("-3,10")).toBe(-310);
  });
  it("Mengen in Milli", () => { expect(toMilli("2")).toBe(2000); expect(toMilli("2,5")).toBe(2500); expect(toMilli("0")).toBe(0); expect(toMilli("x")).toBeNull(); });
  it("Prozent in Permille, Rueckformat", () => { expect(toPermille("10")).toBe(100); expect(toPermille("2,5")).toBe(25); expect(fromPermille(25)).toBe("2,5"); expect(fromCents(1250)).toBe("12,50"); expect(fromMilli(2500)).toBe("2,5"); expect(fromMilli(2000)).toBe("2"); });
});
```

```ts
// test/unit/editor-draft.test.ts
import { describe, it, expect } from "vitest";
import { draftReducer, emptyDraft, toInvoicePayload, toDocumentPayload, toDeliveryNotePayload, draftFromInvoice, validateDraft } from "@/lib/editor/draft";
import { createInvoiceSchema, updateInvoiceSchema, createDocumentSchema, createDeliveryNoteSchema } from "@/schemas";

function invoiceDraft() {
  let s = emptyDraft("INVOICE");
  s = draftReducer(s, { type: "set", field: "customerId", value: "c1" });
  s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "Beratung", quantity: "2", price: "95,00", unit: "HUR" } });
  s = draftReducer(s, { type: "addLine", lineType: "HEADING" });
  s = draftReducer(s, { type: "setLine", key: s.lines[1]!.key, patch: { description: "Abschnitt" } });
  return s;
}

describe("editor/draft", () => {
  it("emptyDraft startet mit einer leeren ITEM-Zeile und ist nicht dirty", () => {
    const s = emptyDraft("INVOICE");
    expect(s.lines).toHaveLength(1); expect(s.lines[0]!.lineType).toBe("ITEM"); expect(s.lines[0]!.unit).toBe("C62"); expect(s.dirty).toBe(false);
  });
  it("set/setLine markieren dirty; markSaved setzt zurueck", () => {
    let s = draftReducer(emptyDraft("INVOICE"), { type: "set", field: "subject", value: "Test" });
    expect(s.dirty).toBe(true); s = draftReducer(s, { type: "markSaved" }); expect(s.dirty).toBe(false);
  });
  it("addLine/duplicateLine/moveLine/removeLine", () => {
    let s = emptyDraft("DOCUMENT");
    const k0 = s.lines[0]!.key;
    s = draftReducer(s, { type: "addLine", lineType: "TEXT", after: k0 });
    expect(s.lines.map((l) => l.lineType)).toEqual(["ITEM", "TEXT"]);
    s = draftReducer(s, { type: "duplicateLine", key: k0 });
    expect(s.lines.map((l) => l.lineType)).toEqual(["ITEM", "ITEM", "TEXT"]);
    expect(s.lines[1]!.key).not.toBe(k0);
    s = draftReducer(s, { type: "moveLine", key: s.lines[2]!.key, to: 0 });
    expect(s.lines[0]!.lineType).toBe("TEXT");
    s = draftReducer(s, { type: "removeLine", key: s.lines[0]!.key });
    expect(s.lines).toHaveLength(2);
    s = draftReducer(s, { type: "removeLine", key: s.lines[0]!.key }); s = draftReducer(s, { type: "removeLine", key: s.lines[0]!.key });
    expect(s.lines).toHaveLength(1); // nie leer: letzte Zeile wird durch eine leere ITEM-Zeile ersetzt
  });
  it("applyProduct uebernimmt Preis/Einheit/Steuer/Artikelnummer als Anzeige-Strings", () => {
    let s = emptyDraft("INVOICE");
    s = draftReducer(s, { type: "applyProduct", key: s.lines[0]!.key, product: { id: "p1", name: "Lizenz", unit: "C62", netPriceCents: 24000, taxRate: 19, articleNumber: "LZ-1" } });
    expect(s.lines[0]).toMatchObject({ description: "Lizenz", price: "240,00", unit: "C62", taxRate: 19, articleNumber: "LZ-1", productId: "p1" });
  });
  it("toInvoicePayload ergibt ein gueltiges createInvoiceSchema-Objekt (Neuanlage) und updateInvoiceSchema (Bearbeiten)", () => {
    const s = invoiceDraft();
    const create = createInvoiceSchema.safeParse(toInvoicePayload(s, false));
    expect(create.success, JSON.stringify(create.error?.issues)).toBe(true);
    if (create.success) {
      expect(create.data.lines[0]).toMatchObject({ quantityMilli: 2000, unitNetPriceCents: 9500, unit: "HUR", taxRate: 19, lineType: "ITEM" });
      expect(create.data.lines[1]).toMatchObject({ lineType: "HEADING", quantityMilli: 0, unitNetPriceCents: 0 });
      expect(create.data.type).toBe("INVOICE"); expect(create.data.currency).toBe("EUR");
    }
    const update = updateInvoiceSchema.safeParse(toInvoicePayload(s, true));
    expect(update.success).toBe(true);
    expect("type" in toInvoicePayload(s, true)).toBe(false);
  });
  it("Kleinunternehmer: Steuersatz 0/Kategorie E und Hinweis in notes", () => {
    let s = invoiceDraft(); s = draftReducer(s, { type: "set", field: "taxScheme", value: "KLEINUNTERNEHMER" });
    const p = createInvoiceSchema.parse(toInvoicePayload(s, false));
    expect(p.lines[0]).toMatchObject({ taxRate: 0, taxCategory: "E" }); expect(p.notes ?? "").toContain("§ 19");
  });
  it("toDocumentPayload/toDeliveryNotePayload sind schema-gueltig", () => {
    let d = emptyDraft("DOCUMENT"); d = draftReducer(d, { type: "set", field: "customerId", value: "c1" });
    d = draftReducer(d, { type: "setLine", key: d.lines[0]!.key, patch: { description: "Pos", quantity: "1", price: "10" } });
    expect(createDocumentSchema.safeParse(toDocumentPayload(d, false)).success).toBe(true);
    let n = emptyDraft("DELIVERY_NOTE"); n = draftReducer(n, { type: "set", field: "customerId", value: "c1" });
    n = draftReducer(n, { type: "setLine", key: n.lines[0]!.key, patch: { description: "Ware", quantity: "3" } });
    expect(createDeliveryNoteSchema.safeParse(toDeliveryNotePayload(n)).success).toBe(true);
  });
  it("draftFromInvoice rundet Cent/Milli/Permille in Anzeige-Strings und zurueck", () => {
    const s = draftFromInvoice({ id: "i1", customerId: "c1", taxScheme: "REGULAR", subject: "S", lines: [{ lineType: "ITEM", description: "A", descriptionLong: "", articleNumber: "", quantity: "1,5", unit: "C62", price: "12,34", taxRate: 19, discountPercent: "10", discountAmount: "" }] } as never);
    expect(s.id).toBe("i1"); expect(s.lines[0]!.price).toBe("12,34"); expect(s.dirty).toBe(false);
    const p = updateInvoiceSchema.parse(toInvoicePayload(s, true));
    expect(p.lines?.[0]).toMatchObject({ quantityMilli: 1500, unitNetPriceCents: 1234, discountPermille: 100 });
  });
  it("validateDraft nennt fehlenden Kunden, fehlende Position und ungueltigen Preis", () => {
    let s = emptyDraft("INVOICE");
    expect(validateDraft(s)).toEqual(expect.arrayContaining([expect.stringContaining("Kunde")]));
    s = draftReducer(s, { type: "set", field: "customerId", value: "c1" });
    s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "x", quantity: "1", price: "abc" } });
    expect(validateDraft(s).join(" ")).toContain("Preis");
  });
});
```

```ts
// test/unit/editor-totals.test.ts
import { describe, it, expect } from "vitest";
import { draftReducer, emptyDraft } from "@/lib/editor/draft";
import { computeDraftTotals } from "@/lib/editor/totals";
describe("editor/totals", () => {
  it("Netto, Rabatt, Steuer je Satz, Brutto, Zwischensumme", () => {
    let s = emptyDraft("INVOICE");
    s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "A", quantity: "2", price: "100", taxRate: 19, discountPercent: "10" } });
    s = draftReducer(s, { type: "addLine", lineType: "ITEM" });
    s = draftReducer(s, { type: "setLine", key: s.lines[1]!.key, patch: { description: "B", quantity: "1", price: "50", taxRate: 7 } });
    s = draftReducer(s, { type: "addLine", lineType: "SUBTOTAL" });
    s = draftReducer(s, { type: "set", field: "documentDiscountPercent", value: "5" });
    const t = computeDraftTotals(s);
    expect(t.lineNetCents).toBe(18000 + 5000);
    expect(t.subtotals[2]).toBe(23000);
    expect(t.allowanceCents).toBe(1150);
    expect(t.netCents).toBe(21850);
    expect(t.taxRows.map((r) => r.rate)).toEqual([19, 7]);
    expect(t.grossCents).toBe(t.netCents + t.taxCents);
    expect(t.error).toBeNull();
  });
  it("Kleinunternehmer: keine Steuer", () => {
    let s = emptyDraft("INVOICE"); s = draftReducer(s, { type: "set", field: "taxScheme", value: "KLEINUNTERNEHMER" });
    s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "A", quantity: "1", price: "100", taxRate: 19 } });
    const t = computeDraftTotals(s); expect(t.taxCents).toBe(0); expect(t.grossCents).toBe(10000);
  });
  it("ungueltige Eingabe liefert error statt zu werfen", () => {
    let s = emptyDraft("INVOICE"); s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "A", quantity: "1", price: "x" } });
    expect(computeDraftTotals(s).error).not.toBeNull();
  });
});
```

Die genauen Zahlen (Rabatt 5 % auf 230,00 = 11,50; Verteilung auf Steuersätze über `applyDocumentAdjustments`) mit den bestehenden Funktionen `computeLineNet`/`applyDocumentAdjustments`/`computeSubtotals` nachrechnen und die Erwartungen ggf. an deren Rundung anpassen — die Funktionen sind die Referenz, nicht der Test.

- [ ] **Step 2: Tests fehlschlagen lassen** — Run: `npx vitest run test/unit/editor-*.test.ts` — Expected: FAIL (`Cannot find module '@/lib/editor/...'`).

- [ ] **Step 3: Implementieren**

`parse.ts`: `toCents = (s) => { const t = s.trim(); if (!t) return null; const n = parseEuroToCents(t); return Number.isFinite(n) ? n : null; }` — prüfe `parseEuroToCents`/`parseQuantityToMilli` in `src/lib/money.ts` (werfen sie oder liefern sie NaN?) und kapsele so, dass ungültige Eingaben `null` ergeben; `toPermille` = Prozent-String → `Math.round(parseFloat(normalisiert) * 10)`; `fromCents` = `formatCents(cents)` ohne Währungszeichen (eigene Formatierung mit `Intl.NumberFormat("de-DE", { minimumFractionDigits: 2 })`), `fromMilli` mit bis zu 3 Nachkommastellen ohne Nullen.

`draft.ts`: `emptyDraft(mode)` = alle Strings leer, `taxScheme: "REGULAR"`, `kind: "ANGEBOT"`, `type: "INVOICE"`, `showPrices: false, showTax: false, showArticleNumber: true, showDescription: true, showDeliveryAddress: true`, `lines: [emptyLine("ITEM")]`, `grossDisplay: false`, `dirty: false`. `emptyLine` mit `key: crypto.randomUUID()` (Node ≥ 19 / Browser; in Tests vorhanden), `quantity: "1"`, `unit: "C62"`, `taxRate: 19`. Reducer: jede Änderung setzt `dirty: true` außer `replace`/`markSaved`. `removeLine` ersetzt die letzte verbleibende Zeile durch eine leere ITEM-Zeile. `applyProduct` setzt `description` nur, wenn sie leer ist oder der vorherige Produktname war (Muster aus `ProductPicker`-Verwendung in `NewInvoiceForm` übernehmen), `price: fromCents(netPriceCents)`, `unit`, `taxRate` (19/7/0 narrow, sonst 19), `articleNumber`, `productId`.

Payload-Mapper: exakt die Objekte aus `NewInvoiceForm.submit` (Kontext §1, L387-457 dort lesen und übertragen: `optionalSelectValue(value, isEdit)`, `SCHEME_NOTICE`-Anhang an `notes`, `documentDiscountPermille/Cents` leer ⇒ `isEdit ? 0 : undefined`, Skonto-Felder nur wenn beide Werte gesetzt, `lines` über `buildLinesPayload`-Logik: Nicht-ITEM-Zeilen mit `quantityMilli: 0, unitNetPriceCents: 0, discountPermille: 0, discountCents: 0, taxRate: 0`? — prüfe `invoiceLineInputSchema.superRefine` (Kontext §3): Nicht-ITEM verlangt Menge/Preis/Rabatt/Steuer = 0). `toDocumentPayload` aus `NewDocumentForm.submit` (Kontext §1, L315-387) inkl. `taxScheme: "REGULAR"`. `toDeliveryNotePayload` aus `DeliveryNoteForm` (nur ITEM-Zeilen, `quantityMilli` positiv, optional `unitNetPriceCents`/`taxRate` nur wenn `showPrices`).

`totals.ts`: den `useMemo`-Block aus `NewInvoiceForm` (L298-369) als reine Funktion; `DOCUMENT`/`DELIVERY_NOTE` behandeln wie `REGULAR`.

- [ ] **Step 4: Tests, Typecheck, Commit**

Run: `npx vitest run test/unit/editor-*.test.ts && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add src/lib/editor test/unit/editor-*.test.ts
git commit -s -m "feat(editor): Entwurfsmodell, Reducer, Payload-Mapper und Summen als reine Funktionen (Phase 11c, Task 1)"
```

---

### Task 2: Vorschau-Route für ungespeicherte Entwürfe + Wasserzeichen

**Files:**
- Create: `src/domain/settings/preview-draft.ts`, `src/app/api/pdf/preview/route.ts`
- Modify: `src/lib/pdf/theme.ts` (`watermark?: string`), `src/lib/pdf/marks.ts` (`drawWatermark(doc, text)`), die drei Engines (im Seiten-Loop nach Fußzeile: `if (theme.watermark) drawWatermark(doc, theme.watermark)`), `src/proxy.ts` (keine Änderung nötig — Route ist sessiongeschützt; prüfen, dass `/api/pdf/` NICHT in `PUBLIC_PREFIXES` steht)
- Test: `test/integration/pdf-preview-route.test.ts`, `test/unit/pdf-layouts.test.ts` (Wasserzeichen-Text erscheint je Seite)

**Interfaces (Produces):**
```ts
// POST /api/pdf/preview  body: { kind: "INVOICE" | "DOCUMENT" | "DELIVERY_NOTE"; payload: unknown; layoutId?: LayoutId }
// 200 application/pdf (inline), 400 { error, details } bei Zod-Fehler, 404 ohne Organisation/Kunde, 401 ohne Session (Proxy)
export async function buildDraftPreview(orgId: string, body: PreviewBody): Promise<Buffer>;
```
Verhalten: `payload` wird mit `createInvoiceSchema` / `createDocumentSchema` / `createDeliveryNoteSchema` geparst (Neuanlage-Schema auch beim Bearbeiten — `id` wird ignoriert). Kunde per `dbInternal.customer.findFirst({ where: { id: payload.customerId, orgId }, select: … })`, Organisation per `getActiveOrg`-Ergebnis. Daten: INVOICE/DOCUMENT über `buildDocEInvoiceData({ number: null, kind, issueDate: new Date(), … , org, customer, lines })` wie in `src/domain/settings/preview.ts`; danach `data.number = "ENTWURF"`, `data.type` = `payload.type` (INVOICE/CREDIT_NOTE) bzw. `kind`; Rechnung: `dueDate`, `paymentTermsHuman = payload.paymentTerms ?? null`, `deliveryDate/Start/End`, `buyerReference`, `giroAmountCents = payableCents` (nur INVOICE-Familie), `headerText/footerText` aus Payload (Platzhalter werden NICHT aufgelöst — Hinweis im Wasserzeichen-Text nicht nötig, aber in LIMITATIONEN). `internalNotes` werden nie übergeben. DELIVERY_NOTE: `DeliveryNotePdfData` direkt aus Payload + Org + Kunde (Felder analog `buildSampleDeliveryNoteData`). Theme: `loadPdfTheme(org.id, null, docType)`, dann `theme.layoutId = body.layoutId ?? theme.layoutId`, `theme.watermark = "VORSCHAU"`.

`drawWatermark`: diagonaler grauer Text (`#c8c8c8`, 60 pt, Opacity 0.25, `rotate(-35)` um die Seitenmitte, `save/restore`) auf jeder Seite; in Tests wird der Text „VORSCHAU" pro Seite gezählt.

- [ ] **Step 1: Failing tests**

```ts
// test/integration/pdf-preview-route.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({ getActiveOrg: async () => { if (!orgStore.id) throw new Error("no org"); return { id: orgStore.id, legalName: "Preview Test GmbH", addressLine1: "A 1", addressLine2: null, postalCode: "1", city: "B", country: "DE", vatId: "DE123456789", taxNumber: null, email: null, phone: null, electronicAddress: null, iban: "DE02120300000000202051", bic: null, bankName: null, website: null, ownerName: null }; } }));
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { POST as previewPost } from "@/app/api/pdf/preview/route";
import { parsePdf } from "../helpers/pdf-theme";

let orgId: string; let customerId: string;
beforeAll(async () => {
  const org = await dbInternal.organization.create({ data: { legalName: "Preview Test GmbH", addressLine1: "A 1", postalCode: "1", city: "B", vatId: "DE123456789", taxNumber: "74/1", iban: "DE02120300000000202051" } });
  orgId = org.id; orgStore.id = orgId; await ensureOrgMasterdata(dbInternal, orgId);
  const c = await dbInternal.customer.create({ data: { orgId, name: "Vorschau Kunde AG", addressLine1: "K 1", postalCode: "2", city: "C", type: "BUSINESS", customerNumber: "K-74" } });
  customerId = c.id;
});
function req(body: unknown) { return new Request("http://localhost/api/pdf/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
const line = { lineType: "ITEM", description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 9500, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };

describe("POST /api/pdf/preview", () => {
  it("rendert eine Rechnungsvorschau ohne DB-Schreibzugriff, mit ENTWURF und Wasserzeichen", async () => {
    const before = await dbInternal.invoice.count();
    const res = await previewPost(req({ kind: "INVOICE", layoutId: "schlicht", payload: { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", subject: "Test", paymentTerms: "Zahlbar in 14 Tagen.", internalNotes: "GEHEIM-NOTIZ", lines: [line] } }));
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toBe("application/pdf"); expect(res.headers.get("cache-control")).toBe("no-store");
    const { text, numpages } = await parsePdf(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain("ENTWURF"); expect(text).toContain("Vorschau Kunde AG"); expect(text).toContain("Beratung");
    expect((text.match(/VORSCHAU/g) ?? []).length).toBeGreaterThanOrEqual(numpages);
    expect(text).not.toContain("GEHEIM");
    expect(await dbInternal.invoice.count()).toBe(before);
  });
  it("Angebot und Lieferschein rendern; 400 bei Zod-Fehler; 404 bei fremdem Kunden", async () => {
    const doc = await previewPost(req({ kind: "DOCUMENT", payload: { kind: "ANGEBOT", customerId, currency: "EUR", lines: [line] } }));
    expect(doc.status).toBe(200);
    const dn = await previewPost(req({ kind: "DELIVERY_NOTE", payload: { customerId, lines: [{ description: "Ware", quantityMilli: 3000, unit: "C62" }] } }));
    expect(dn.status).toBe(200);
    const bad = await previewPost(req({ kind: "INVOICE", payload: { customerId, lines: [] } }));
    expect(bad.status).toBe(400);
    const foreign = await previewPost(req({ kind: "INVOICE", payload: { customerId: "gibtsnicht", type: "INVOICE", currency: "EUR", lines: [line] } }));
    expect(foreign.status).toBe(404);
  });
});
```
Hinweis: Die Preview-Route muss auf `compress: false` schalten dürfen? Nein — Tests parsen komprimierte PDFs meist; falls `pdf-parse` „bad XRef" wirft, in der Route `theme.compress` NICHT setzen, sondern im Test das Ergebnis mit `qpdf`-freier Toleranz prüfen: Ruling → die Route akzeptiert einen Query-Parameter `?compress=0` NUR wenn `process.env.NODE_ENV === "test"`; Tests nutzen ihn.

- [ ] **Step 2: Fehlschlag prüfen** — Run: `npx vitest run test/integration/pdf-preview-route.test.ts` — Expected: FAIL (Modul fehlt).

- [ ] **Step 3: Implementieren** — `preview-draft.ts` nach obigem Verhalten; Route: `getActiveOrg` → 404 bei Fehler, Body-Zod `z.object({ kind: z.enum([...]), payload: z.unknown(), layoutId: layoutIdSchema.optional() })`, dann `buildDraftPreview`; Fehlerform `{ error, details }` bei Zod (Statuscode 400), `NotFoundError` → 404. Wasserzeichen in `marks.ts` + Engines (nach der Fußzeile im Seitenloop). `PdfTheme.watermark?: string` (optional, `testPdfTheme` bleibt unverändert).

- [ ] **Step 4: Tests, Commit**

Run: `npx vitest run test/integration/pdf-preview-route.test.ts test/unit/pdf-layouts.test.ts test/integration/pdf-theme.test.ts && npm run typecheck && npm run lint` — Expected: PASS.

```bash
git add src/domain/settings/preview-draft.ts src/app/api/pdf/preview src/lib/pdf test/integration/pdf-preview-route.test.ts test/unit/pdf-layouts.test.ts
git commit -s -m "feat(editor): POST /api/pdf/preview rendert ungespeicherte Entwuerfe mit Wasserzeichen (Phase 11c, Task 2)"
```

---

### Task 3: Kunden-Inline-Anlage, Kundensuche, Textvorlagen-Auswahl

**Files:**
- Modify: `src/app/actions/masterdata.ts` (`createCustomerInline`)
- Create: `src/components/editor/CustomerPicker.tsx`, `src/components/editor/NewCustomerDialog.tsx`, `src/components/editor/TextTemplatePicker.tsx`
- Test: `test/integration/customer-inline-action.test.ts`

**Interfaces (Produces):**
```ts
// masterdata.ts
export interface CreateCustomerInlineInput { name: string; type?: "BUSINESS"|"PRIVATE"; addressLine1: string; postalCode: string; city: string; email?: string; vatId?: string }
export type CreateCustomerInlineResult = { ok: true; customer: { id: string; name: string; customerNumber: string | null; email: string | null; defaultPaymentMethodId?: string | null } } | { ok: false; error: string };
export async function createCustomerInline(input: CreateCustomerInlineInput): Promise<CreateCustomerInlineResult>; // customerSchema.safeParse + createCustomer(org.id, v) — dieselbe Domain-Funktion wie das Kundenformular; KEIN redirect
// CustomerPicker
export interface CustomerOption { id: string; name: string; customerNumber?: string | null; email?: string | null; defaultPaymentMethodId?: string | null; defaultDiscountPermille?: number | null /* falls vorhanden */ }
export function CustomerPicker(props: { customers: CustomerOption[]; value: string; onChange: (id: string, customer: CustomerOption | null) => void; onCreated?: (c: CustomerOption) => void; disabled?: boolean }): JSX.Element;
// TextTemplatePicker
export function TextTemplatePicker(props: { docType: string; position: "HEAD"|"FOOT"|"TERMS_DELIVERY"|"TERMS_PAYMENT"; onPick: (body: string) => void }): JSX.Element; // laedt GET /api/text-templates?docType=&position= (Route pruefen: `ls src/app/api/text-templates`; falls nur /pick existiert, eine Listen-Route `GET /api/text-templates?docType=&position=` ergaenzen, die `listTextTemplates` aus der Domain nutzt)
```

- [ ] **Step 1: Failing test**

```ts
// test/integration/customer-inline-action.test.ts
import { describe, it, expect, beforeAll, vi } from "vitest";
const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({ getActiveOrg: async () => ({ id: orgStore.id! }) }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createCustomerInline } from "@/app/actions/masterdata";
beforeAll(async () => {
  const org = await dbInternal.organization.create({ data: { legalName: "Inline Kunde GmbH", addressLine1: "A", postalCode: "1", city: "B", vatId: "DE744444444", taxNumber: "74/4" } });
  orgStore.id = org.id; await ensureOrgMasterdata(dbInternal, org.id);
});
describe("createCustomerInline", () => {
  it("legt einen Kunden mit Kundennummer an und liefert ihn zurueck", async () => {
    const r = await createCustomerInline({ name: "Neu AG", addressLine1: "Weg 1", postalCode: "12345", city: "Stadt", email: "neu@example.org" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.customer.name).toBe("Neu AG"); expect(r.customer.customerNumber).toMatch(/\S/); const row = await dbInternal.customer.findUnique({ where: { id: r.customer.id } }); expect(row?.orgId).toBe(orgStore.id); }
  });
  it("Zod-Fehler werden als ok:false gemeldet", async () => {
    const r = await createCustomerInline({ name: "", addressLine1: "", postalCode: "", city: "" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Fehlschlag prüfen** — Run: `npx vitest run test/integration/customer-inline-action.test.ts` — Expected: FAIL (Export fehlt).

- [ ] **Step 3: Implementieren** — Action nach dem Muster `createProductInline` (Kontext §3); `CustomerPicker`: Eingabefeld mit Dropdown (Filter über Name, Kundennummer, E-Mail; max. 30 Treffer; Tastatur Pfeil/Enter/Escape wie `CommandPalette`), gewählter Kunde als Chip mit „ändern", Eintrag „+ Neuen Kunden anlegen" öffnet `NewCustomerDialog` (natives `<dialog>`, KEIN `<form>` — Hydration-Hinweis aus `NewProductDialog` übernehmen), nach Erfolg `onCreated` + `onChange`. `TextTemplatePicker`: `<select>` „Vorlage einfügen…" mit Namen, Auswahl ruft `onPick(body)`; leer wenn keine Vorlagen.

- [ ] **Step 4: Tests, Commit**

```bash
npx vitest run test/integration/customer-inline-action.test.ts && npm run typecheck && npm run lint
git add src/app/actions/masterdata.ts src/components/editor/CustomerPicker.tsx src/components/editor/NewCustomerDialog.tsx src/components/editor/TextTemplatePicker.tsx src/app/api/text-templates test/integration/customer-inline-action.test.ts
git commit -s -m "feat(editor): Kundensuche mit Inline-Anlage und Textvorlagen-Auswahl (Phase 11c, Task 3)"
```

---

### Task 4: DocumentEditor-Rahmen und Kopfblöcke (Header, Empfänger, Belegdaten, Kopftext, Weitere Optionen, Anhänge)

**Files:**
- Create: `src/components/editor/DocumentEditor.tsx`, `src/components/editor/EditorField.tsx`, `src/components/editor/blocks/EditorHeader.tsx`, `RecipientBlock.tsx`, `MetaBlock.tsx`, `HeadTextBlock.tsx`, `MoreOptions.tsx`, `AttachmentsBlock.tsx`
- Test: keine Komponententests (kein RTL); Typecheck/Lint/Build + Task 6 Smoke

**Interfaces (Produces):**
```ts
export interface DocumentEditorProps {
  mode: EditorMode;
  initial?: DraftState;                       // aus draftFromInvoice/draftFromDocument (Bearbeiten) oder emptyDraft (Neu)
  customers: CustomerOption[]; products: ProductOption[]; paymentMethods?: { id: string; name: string }[]; contacts?: { id: string; customerId: string; name: string }[]; addresses?: { id: string; customerId: string; type: string; label: string }[];
  layouts: { id: LayoutId; name: string }[];
  effectivePrintOptions?: EffectivePrintOptions; printOverride?: PrintOptionsOverride; // nur Bearbeiten
  attachments?: AttachmentItem[];             // nur Bearbeiten
  offerLastDocument?: boolean;
  backHref: string; title: string;            // "Neue Rechnung" / "Rechnung bearbeiten" / …
}
```
Verhalten: `useReducer(draftReducer, initial ?? emptyDraft(mode))`; `save()` → Payload über `toXPayload`, `POST`/`PATCH` wie heute (Routen/Antworten aus Kontext §3), Fehler `{ error }` als Banner, Erfolg → `router.push(detailHref)` (`/rechnungen/{id}`, `/dokumente/{id}`, `/lieferscheine/{id}`); `preview()` → `PreviewSheet` (Task 5) mit `POST /api/pdf/preview`; Unsaved-Guard über `beforeunload` und Klick auf „Zurück" (Bestätigung per `window.confirm` ist verboten? Nein — für Verlassen-Bestätigung ist `beforeunload` Browser-Standard; für den Zurück-Link ein eigener kleiner Bestätigungs-`<dialog>`).

Layout (Spec „Editor"):
- `EditorHeader` (sticky `top-0 z-20 bg-white/95 backdrop-blur border-b`): links Zurück-Link + Titel + Status-Badge „Entwurf"/„ungespeichert"; rechts „Vorschau", „Speichern" (sekundär), Primärknopf: Rechnung Neu → „Als Entwurf speichern", Bearbeiten → „Änderungen speichern"; Dokument Neu → „Dokument anlegen"; Lieferschein → „Lieferschein anlegen". (Festschreiben bleibt auf der Detailseite — Ruling: kein Doppelpfad im Editor, GoBD-Aktion bewusst getrennt.)
- Zweispaltig ab `md`: links `RecipientBlock` (CustomerPicker, darunter Anschrift-Vorschau des gewählten Kunden read-only, Ansprechpartner-Select, Rechnungsadresse/Lieferadresse-Selects gefiltert auf `customerId`, `TakeOverPrompt` bei Neuanlage wie heute), rechts `MetaBlock`: INVOICE: Typ (Rechnung/Gutschrift, nur Neu), Steuerschema, Leistungsdatum, Fällig am + „in n Tagen"-Kurzwahl (14/30), Zahlungsmethode; DOCUMENT: Art (nur Neu), Gültig bis, Kundenreferenz; DELIVERY_NOTE: Lieferdatum, Versanddatum; alle: Betreff.
- `HeadTextBlock`: Kopftext (`RichTextField`? Nein: Kopf-/Fußtext sind Klartext-Textareas wie heute) + `TextTemplatePicker` (Position HEAD); für DOCUMENT bleibt die Autovorbelegung beim Anlegen (Kontext §1) erhalten — im Editor als Effekt bei `mode === "DOCUMENT" && !initial`.
- `MoreOptions` (`<details>`, geschlossen): INVOICE: Bestellnummer, interne Referenz, Leitweg-ID, Leistungszeitraum von/bis, Beleg-Rabatt/-Aufschlag (Prozent/Betrag/Grund), Skonto 1/2, interne Notizen (Amber-Badge), Druckoptionen (`PrintOptionsPanel` nur Bearbeiten, sonst Hinweis); DOCUMENT: Lieferbedingungen + Zahlungsbedingungen (mit `TextTemplatePicker` TERMS_*), Beleg-Rabatt/-Aufschlag, interne Notizen, Druckoptionen; DELIVERY_NOTE: Darstellungs-Schalter (showPrices/showTax/showArticleNumber/showDescription/showDeliveryAddress), interne Notizen.
- `AttachmentsBlock`: Bearbeiten → `AttachmentPanel`; Neu → Hinweis „Anhänge nach dem Speichern".
- `EditorField`: `label`, `hint?`, `children`; Inputs mit `inputCls` aus `src/components/forms/fields.tsx` (dort exportieren, falls noch nicht).

- [ ] **Step 1: Komponenten anlegen** (Code entlang der heutigen Formulare: die JSX-Abschnitte aus `NewInvoiceForm` L470-598 und `NewDocumentForm` L405-461/594-633 in die Blöcke übertragen, State-Zugriffe durch `draft`/`dispatch` ersetzen). `DocumentEditor` rendert vorerst die Kopfblöcke + einen Platzhalter „Positionen (Task 5)".
- [ ] **Step 2: `npm run typecheck && npm run lint`** — Expected: sauber. (Noch keine Seite nutzt den Editor.)
- [ ] **Step 3: Commit**

```bash
git add src/components/editor src/components/forms/fields.tsx
git commit -s -m "feat(editor): DocumentEditor-Rahmen mit Kopfbloecken, Optionen und Anhaengen (Phase 11c, Task 4)"
```

---

### Task 5: Positionstabelle, Summen, Fußtext, Vorschau-Sheet

**Files:**
- Create: `src/components/editor/blocks/LineItemsEditor.tsx`, `LineRow.tsx`, `TotalsBlock.tsx`, `FootTextBlock.tsx`, `PreviewSheet.tsx`
- Modify: `src/components/editor/DocumentEditor.tsx` (Blöcke einhängen, `preview()`)

**Interfaces (Produces):**
- `LineItemsEditor({ draft, dispatch, products, mode })`: Kopfzeile Pos. | Beschreibung | Menge | Einheit | Preis (netto/brutto je `grossDisplay`) | USt. | Rabatt | Betrag | ⋯; Brutto/Netto-Umschalter (`grossDisplay`, reine Anzeige: Brutto = Netto × (1 + Satz), Eingabe bleibt netto — Hinweis im Tooltip); pro Zeile `LineRow`; unten Links „+ Position", „+ Überschrift", „+ Textzeile", „+ Zwischensumme"; Drag-Handle (bestehende `dragIndex`-Logik aus `NewInvoiceForm` übernehmen) + Tastatur (Alt+↑/↓ = `moveLine`).
- `LineRow`: ITEM: `ProductPicker` in der Beschreibungszelle (Eingabe = Beschreibung, Vorschläge aus `products`, Auswahl → `applyProduct`), Menge, Einheit (`<select>` aus `UNIT_OPTIONS` + Freitext-Option „andere…"), Preis, USt (`TAX_RATE_OPTIONS`, disabled wenn `taxScheme !== "REGULAR"` im INVOICE-Modus), Rabatt (% oder €: ein Feld mit Umschalter), Betrag (berechnet, read-only), Aktionen ⋯ (Duplizieren, Langtext ein/aus, Entfernen). Langtext (`RichTextField`) und Artikelnummer erscheinen aufgeklappt unter der Zeile (`expanded`). HEADING/TEXT/SUBTOTAL: reduzierte Zeile (Bezeichnung bzw. `RichTextField` bei TEXT). Enter in der letzten Zeile → `addLine("ITEM")` + Fokus auf die neue Beschreibung.
- `TotalsBlock({ totals, draft })`: Zwischensumme, Rabatt/Aufschlag, Netto, USt je Satz, Brutto fett, Skonto-Hinweis (aus `skonto1/2`), Fehlertext aus `totals.error`.
- `FootTextBlock`: Fußtext + `TextTemplatePicker` FOOT, Notiz/Hinweis (`notes`).
- `PreviewSheet({ open, onClose, mode, draft, layoutId })`: rechtes Seiten-Sheet (feste Breite `max-w-3xl`, Overlay), beim Öffnen `POST /api/pdf/preview` mit `{ kind, payload: toXPayload(draft, false), layoutId }` als `fetch` → Blob → `URL.createObjectURL` → `<iframe>`; „Neu laden"; `revokeObjectURL` beim Schließen; Fehlerbanner bei 400 (Zod-Details lesbar auflisten).

- [ ] **Step 1: Komponenten anlegen** — Positions-JSX aus `NewInvoiceForm` L600-710 als Basis; Summen-Footer L768-792.
- [ ] **Step 2: `npm run typecheck && npm run lint`** — sauber.
- [ ] **Step 3: Commit**

```bash
git add src/components/editor
git commit -s -m "feat(editor): Positionstabelle mit Produktsuche, Summenblock, Fusstext, Vorschau-Sheet (Phase 11c, Task 5)"
```

---

### Task 6: Seiten umstellen, alte Formulare entfernen, Smoke

**Files:**
- Modify: `src/app/rechnungen/neu/page.tsx`, `src/app/rechnungen/[id]/bearbeiten/page.tsx`, `src/app/dokumente/neu/page.tsx`, `src/app/dokumente/[id]/bearbeiten/page.tsx`, `src/app/lieferscheine/neu/page.tsx` (alle: `PageHeader` entfällt zugunsten des `EditorHeader`; Daten laden wie heute, zusätzlich `layouts: listLayouts()`, Print-Options/Anhänge beim Bearbeiten laden — Muster aus den heutigen bearbeiten-Seiten + `lieferscheine/[id]/page.tsx`), `src/components/TakeOverPrompt.tsx` (Props prüfen, an `dispatch({ type: "replace" })` anbinden)
- Delete: `src/components/NewInvoiceForm.tsx`, `src/components/NewDocumentForm.tsx`, `src/components/DeliveryNoteForm.tsx`
- Test: `grep -rn "NewInvoiceForm\|NewDocumentForm\|DeliveryNoteForm" src/ test/` → leer

- [ ] **Step 1: Seiten umstellen** — `initial` über `draftFromInvoice(invoiceInitial)`/`draftFromDocument(documentInitial)` aus den heutigen Initial-Objekten (diese Objekte unverändert weiterbauen).
- [ ] **Step 2: Gate** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build`.
- [ ] **Step 3: Smoke (Playwright, `webapp-testing`-Skill, Seed-Login)** — Rechnung: `/rechnungen/neu` → Kunde suchen + wählen → Position: „Bera" tippen → Produkt wählen → Menge 2 → Vorschau öffnen (PDF im Sheet, „ENTWURF"/„VORSCHAU") → Als Entwurf speichern → Detailseite → Bearbeiten → Überschrift + Zwischensumme einfügen → Speichern → PDF der Rechnung zeigt beide. Angebot: `/dokumente/neu` → Art AB → Kopftext-Vorlage einfügen → anlegen. Lieferschein: `/lieferscheine/neu` → anlegen. Neuen Kunden inline anlegen. Screenshots unter `scratchpad/ui-previews/11c-*.png`.
- [ ] **Step 4: Commit**

```bash
git add -A src/app src/components
git commit -s -m "feat(editor): Seiten auf DocumentEditor umgestellt, alte Formulare entfernt (Phase 11c, Task 6)"
```

---

### Task 7: Doku, LIMITATIONEN, Gesamtprüfung

**Files:**
- Modify: `docs/ARCHITEKTUR.md` (Abschnitt „Editor (Phase 4b)" um „Phase 11c: DocumentEditor" ergänzen — Blöcke, Entwurfsmodell, Vorschau-Route, Inline-Kunde; L217/L293/L322 anpassen), `docs/ANLEITUNG.md` (Abschnitt Beleg erstellen neu beschreiben; §6 Layouts aus 11b nachziehen — veralteter Satz „ein Layout org-weit"), `docs/LIMITATIONEN.md` (Abschnitt „Editor & Beleganhaenge": Vorschau löst Platzhalter nicht auf und trägt „ENTWURF"; Brutto-Anzeige ist Darstellung, Speicherung netto; Lieferscheine ohne Bearbeitung; Teilgutschrift eigenes Formular; keine Live-PDF beim Tippen), `README.md` (Feature-Satz „unified document editor with live preview"), `docs/API.md` (`POST /api/pdf/preview` als Session-Route, nicht v1)

- [ ] **Step 1: Doku schreiben.**
- [ ] **Step 2: Gate** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check`.
- [ ] **Step 3: Commit**

```bash
git add README.md docs
git commit -s -m "docs(editor): DocumentEditor, Vorschau, Anleitung und Grenzen (Phase 11c, Task 7)"
```

---

## Abschluss-Review (opus) — Prüfpunkte

1. Payload-Gleichheit: `toInvoicePayload`/`toDocumentPayload`/`toDeliveryNotePayload` erzeugen für einen gegebenen Entwurf exakt die Objekte, die die alten Formulare geschickt hätten (Feldnamen, `optionalSelectValue`-Semantik, Skonto-Paare, `SCHEME_NOTICE`).
2. Bearbeiten nur im Entwurf; kein Domain-Direktaufruf; `internalNotes` nie in der Vorschau; Vorschau schreibt nichts.
3. Unsaved-Guard; Enter-Verhalten; Tastaturbedienung der Kundensuche; keine Hydration-Warnung (Dialoge ohne verschachteltes `<form>`).
4. `TakeOverPrompt` funktioniert weiter (Kundenwahl → Übernahme in den Reducer).
5. Alle bisherigen Tests grün; keine toten Exporte; `fields.tsx`-Klassen genutzt statt Duplikate.
6. Playwright-Smoke aus Task 6 mit Screenshots; Betreiber-Abnahme: „Rechnung schreiben ist jetzt so einfach wie bei sevDesk?" — konkret: Kunde, drei Positionen per Produktsuche, Vorschau, Speichern in unter einer Minute.
