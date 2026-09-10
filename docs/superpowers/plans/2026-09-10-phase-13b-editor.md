# Phase 13b — Editor: einspaltig, Datumsfelder, Gesamtrabatt, Betreff in PDF und E-Rechnung, Anhänge im Entwurf

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den Beleg-Editor auf einen einspaltigen Fluss umstellen, die Eingaben vergrößern, die fehlenden Datumsfelder ergänzen (Rechnungsdatum, „Leistungsdatum = Rechnungsdatum", Zahlungsziel als Datum **und** Tageszahl), den seit Phase 4a vorhandenen Gesamtrabatt an die erwartete Stelle unter den Positionen holen, Anhänge schon vor dem ersten Speichern erlauben — und den gespeicherten **Betreff** endlich ausgeben: im PDF aller Layouts und als BT-22-Note mit Subjektcode BT-21 `AAI` in XRechnung und ZUGFeRD/CII.

**Architecture:** Sieben Eingriffe, davon zwei mit Außenwirkung. (1) Reine Oberfläche: `DocumentEditor` löst das Zweispaltenraster auf, `inputCls` wächst, die Positionstabelle bekommt eine eigene dichte Klasse. (2) Der Entwurf lernt `issueDate` (im Payload seit Phase 4b erlaubt, `src/schemas/index.ts:346`, bisher nur serverseitig gesetzt) und zwei reine Ableitungen zwischen `issueDate` und `dueDate` — **kein** neues Prisma-Feld. (3) Der Gesamtrabatt wechselt nur den Ort: dieselben vier Draft-Felder, dasselbe BG-20/BG-21-Mapping. (4) **Betreff:** `EInvoiceData` bekommt `subject`; da `renderInvoicePdf` und die XML-Builder **dieselbe** Struktur lesen, speist ein Mapper-Feld PDF und XML zugleich. Im PDF zeichnet eine gemeinsame Hilfsfunktion in `layouts/shared.ts`, aufgerufen aus den vier `drawKopf`-Implementierungen (die sieben Layouts entstehen daraus). (5) Anhänge im Entwurf speichern den Beleg über den **bestehenden** Speicherweg, bevor der **bestehende** Upload läuft — keine neue Route, kein schwebender Datensatz.

**Tech Stack:** Next.js App Router, Tailwind v4, pdfkit + `pdf-parse` (Tests), xmlbuilder2, SaxonJS/KoSIT-Schematron (`npm run validate:erechnung`), Zod, Vitest (`environment: "node"`, **kein RTL** ⇒ Struktur-, Draft- und PDF/XML-Tests statt Komponententests), Playwright-Smoke über `webapp-testing`.

**Spec:** `docs/superpowers/specs/2026-09-10-phase-13-listen-editor-beleg-design.md` — Paket **B** (Abschnitt 2, „Einspaltiger Editor" bis „Bereits Vorhandenes"), Struktur 3/B, Tests 4/B, Teilphase 2 in Abschnitt 5, Rulings am Dateiende (Betreff wird auch auf bereits festgeschriebenen Belegen gedruckt; BT-22/`AAI` mit Rückfall auf PDF-only).

## Global Constraints

- Branch `phase-13b/editor` aus Fork-`main` (nach dem Merge von 13a). Jeder Commit mit `git commit -s`.
- **Keine Migration, kein Prisma-Feld.** `Invoice.subject`/`Quote.subject`, `documentDiscount*`, `documentCharge*` und `issueDate` existieren alle bereits. `src/lib/db.ts` (GoBD-Guard) bleibt unberührt; kein Schreibpfad fasst eine Spalte eines festgeschriebenen Belegs an.
- **GoBD-Ruling (Spec):** der Betreff wird gedruckt, sobald das Feld gefüllt ist — auch auf bereits festgeschriebenen Belegen. Das ist Darstellung, nicht Inhalt (wie das Phase-7-Ruling zu Druckoptionen und das Phase-12a-Ruling zur GiroCode-Größe); die Hash-Kette bleibt unberührt. Eintrag in `docs/LIMITATIONEN.md` ist Pflicht.
- **E-Rechnung (§52):** `npm run validate:erechnung` bleibt CI-Gate und muss für **alle** Fixtures ACCEPTABLE liefern. Die neue Fixture `betreff-note` ist entweder ACCEPTABLE oder das XML-Mapping wird **ersatzlos entfernt** (PDF-only) — ein „WARNING"-Kompromiss ist unzulässig (Spec-Ruling).
- Nichts doppelt bauen (§1.4): `AttachmentPanel` + `/api/attachments`, `PaymentForm`, `EditorField`, `inputCls`, `ProductPicker`, `grossDisplay`, `documentDiscountPermille/Cents`, `computeDraftTotals`, `drawLogoAndSender`/`drawRecipient`/`drawMetaRows` (`layouts/shared.ts`), `renderTemplate` werden erweitert, nicht kopiert. `EditorHeader` ist **bereits** `sticky top-0 z-20` (`EditorHeader.tsx:103`) — nicht erneut bauen.
- Interne Notizen (§48) bleiben aus PDF, XML, Mail und öffentlichem Angebotslink heraus — `PreviewSheet.tsx:71` entfernt sie schon aus dem Vorschau-Payload; der Regressionstest bleibt grün.
- Zod an der Grenze: `issueDate` nur über `invoiceHeaderFields` (`src/schemas/index.ts:346`), `subject` über dasselbe Objekt (`max(200)`). Keine UI-Validierung als einzige Schranke.
- Geld Integer-Cent, Mengen Integer-Milliunits; die Draft-Felder bleiben Anzeige-Strings, umgerechnet über `src/lib/editor/parse.ts` (wirft nicht).
- TypeScript strict, kein `any`. Dateien ≤ ~250 Zeilen. Deutsche UI-Texte mit echten Umlauten.
- **Prüfkette** (in jedem „Gate + Commit"-Schritt gemeint, im Vordergrund, Timeout 600000 ms): `npm run typecheck && npm run lint && TZ=UTC npm test`. Ab Task 4 zusätzlich `npm run validate:erechnung`; vor dem letzten Commit außerdem `build` und `api:check`. Die 2067 Bestandstests bleiben grün (§1.7).

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/components/editor/DocumentEditor.tsx:265-280` | Zweispaltenraster auflösen, `save({ navigate })` mit Rückgabe der Id |
| `src/components/forms/fields.tsx:5` | `inputCls` größer + neu `inputDenseCls` |
| `src/components/editor/blocks/{LineRow,LineDiscountField,UnitSelect}.tsx` | `inputDenseCls` in der Positionstabelle |
| `src/components/editor/blocks/MetaBlock.tsx:88-122` | Rechnungsdatum, Kopplung Leistungsdatum, „Fällig am" als Paar (Datum + N Tage) |
| `src/lib/editor/draft.ts` | `issueDate`, `deliveryDateFollowsIssue`, `dueDaysFrom`/`dueDateFromDays`, Payload/`draftFrom…` |
| `src/app/rechnungen/[id]/bearbeiten/page.tsx` | `issueDate` in `InvoiceInitialLike` füllen |
| `src/components/editor/blocks/DocumentAdjustmentFields.tsx` | neu — die vier Rabatt-/Aufschlagsfelder, aus `MoreOptions` **verschoben** |
| `src/components/editor/blocks/{LineItemsEditor,MoreOptions}.tsx` | Segmentumschalter netto/brutto, „+ Produkt auswählen"; Rabattblock entfällt |
| `src/lib/einvoice/types.ts:89`, `mapper.ts:306`, `src/domain/document/pdf-data.ts` | `subject` in `EInvoiceData`/`MapInput`/`DocInput` |
| `src/domain/settings/preview-draft.ts:132,169` | `data.subject` aus dem Vorschau-Payload |
| `src/lib/pdf/layouts/{shared,standard,schlicht,klassik,modern}.ts`, `layouts/types.ts` | `drawSubject` + `KopfInput.subject` |
| `src/lib/einvoice/{xrechnung,cii}.ts` | BT-22-Note mit BT-21-Code `AAI` |
| `scripts/{generate-sample-xrechnung,validate-erechnung}.ts` | Fixture `betreff-note` (UBL + CII) |
| `src/components/AttachmentPanel.tsx`, `src/components/editor/blocks/AttachmentsBlock.tsx` | `ensureDocId` — Entwurf speichern, dann hochladen |
| `src/components/shell/{ShellProvider,CommandPalette}.tsx` | Unsaved-Guard der Befehlspalette (Backlog 12e) |
| `test/unit/{editor-draft,editor-layout,einvoice}.test.ts`, `test/integration/{pdf-subject,editor-attachments}.test.ts` | Tests |
| `docs/{ANLEITUNG,LIMITATIONEN,ARCHITEKTUR}.md` | Doku |

### Task 1: Einspaltiger Editor und größere Eingaben

**Files:** Create `test/unit/editor-layout.test.ts` · Modify `src/components/editor/DocumentEditor.tsx:265-280`, `src/components/forms/fields.tsx:5`, `src/components/editor/blocks/{RecipientBlock,MetaBlock,MoreOptions,LineRow,LineDiscountField,UnitSelect}.tsx`

**Ruling:** `inputCls` gilt instanzweit (Stammdaten, Einstellungen, Editor) — die Vergrößerung auf `px-3.5 py-2.5 text-[15px]` ist genau der fortgeschriebene Betreiberwunsch aus Phase 12. Die **Positionstabelle** bekommt eine eigene Klasse `inputDenseCls` (`px-2 py-1 text-sm`), sonst sprengt eine Zeile mit acht Spalten die `min-w-[880px]`-Tabelle. `EditorHeader` ist bereits sticky — nichts zu tun.

- [ ] **Step 1: Failing test schreiben** — Strukturtest über die Dateiinhalte (environment `node`, kein RTL; Muster `test/unit/dialogs.test.ts`):

```ts
// test/unit/editor-layout.test.ts
const SRC = path.resolve(__dirname, "../../src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
it("der Editor laeuft einspaltig", () => {
  expect(read("components/editor/DocumentEditor.tsx")).not.toMatch(/md:grid-cols-2/);
});
it("inputCls ist groesser, inputDenseCls existiert", () => {
  expect(read("components/forms/fields.tsx")).toMatch(/export const inputCls[\s\S]{0,200}py-2\.5/);
  expect(read("components/forms/fields.tsx")).toMatch(/export const inputDenseCls/);
});
it("die Positionstabelle nutzt ausschliesslich die dichte Klasse", () => {
  for (const f of ["blocks/LineRow.tsx", "blocks/LineDiscountField.tsx", "blocks/UnitSelect.tsx"]) {
    const src = read(`components/editor/${f}`);
    expect({ f, dense: /inputDenseCls/.test(src), wide: /\binputCls\b/.test(src) }).toEqual({ f, dense: true, wide: false });
  }
});
it("Regression: der Editor-Kopf bleibt sticky (Phase 12a)", () => {
  expect(read("components/editor/blocks/EditorHeader.tsx")).toMatch(/sticky top-0/);
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/editor-layout.test.ts`.

- [ ] **Step 3: `fields.tsx` anpassen**

```tsx
// src/components/forms/fields.tsx:5
export const inputCls =
  "rounded-md border border-slate-300 px-3.5 py-2.5 text-[15px] focus:border-indigo-500 focus:outline-none disabled:bg-slate-100";
/** Dichte Variante NUR fuer die Positionstabelle des Editors (Phase 13b): dort stehen bis zu
 *  acht Eingaben nebeneinander in einer `min-w-[880px]`-Tabelle — mit `inputCls` bricht die
 *  Zeile um bzw. erzwingt waagerechtes Scrollen. Bewusst dieselbe Rahmen-/Fokusdefinition,
 *  nur kleinere Innenabstaende und Schrift. */
export const inputDenseCls =
  "rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-100";
```

- [ ] **Step 4: Editor einspaltig** — in `DocumentEditor.tsx` das `<div className="grid gap-4 md:grid-cols-2">` um `RecipientBlock`/`MetaBlock` (Z. 265-280) auflösen; Reihenfolge Empfänger → Belegdaten → Kopftext → Positionen → Summen → Fußtext → Weitere Optionen → Anhänge bleibt, jeder Block über die volle Breite. **Innerhalb** von `RecipientBlock`, `MetaBlock` und `MoreOptions` die Felder in `grid gap-4 sm:grid-cols-2 lg:grid-cols-3` legen, damit die Seite nicht endlos wird (`EditorField` trägt bereits `className`).

- [ ] **Step 5: Positionstabelle auf `inputDenseCls`** — in `LineRow.tsx`, `LineDiscountField.tsx`, `UnitSelect.tsx` jedes `inputCls` durch `inputDenseCls` ersetzen (Import anpassen). Andere Blöcke bleiben bei `inputCls`.

- [ ] **Step 6: Gate + Commit** — Prüfkette, dann:
```bash
git add src/components/editor src/components/forms/fields.tsx test/unit/editor-layout.test.ts
git commit -s -m "feat(editor): einspaltiger Aufbau und groessere Eingabefelder (Phase 13b, Task 1)"
```

### Task 2: Rechnungsdatum, Kopplung Leistungsdatum, Zahlungsziel als Datum und Tageszahl

**Files:** Modify `src/lib/editor/draft.ts`, `src/components/editor/blocks/MetaBlock.tsx:88-122`, `src/app/rechnungen/[id]/bearbeiten/page.tsx`, `test/unit/editor-draft.test.ts`

**Interfaces:** `DraftState` bekommt `issueDate: string` und `deliveryDateFollowsIssue: boolean`; neu in `draft.ts`: `dueDaysFrom(issueDate: string, dueDate: string): string` (leer, wenn eines fehlt oder das Ziel vor dem Rechnungsdatum liegt) und `dueDateFromDays(issueDate: string, days: string): string`. Beide rein, ISO-`yyyy-mm-dd`-Strings, Tagesrechnung in UTC.

**Ruling:** Gespeichert wird weiterhin nur `dueDate` — „in N Tagen" ist eine reine Ableitung, kein Feld. Ohne `issueDate` (Neuanlage, Feld leer) rechnet die Ableitung gegen **heute**, weil `createDraftInvoice` (`invoice/create.ts:102`) genau das als Default setzt (`input.issueDate ?? now`) — sonst zeigte der Editor eine andere Frist als der gespeicherte Beleg. Die drei Schnellknöpfe (`MetaBlock.tsx:95-122`) entfallen; ihre Funktion steckt vollständig im Tagesfeld.

- [ ] **Step 1: Failing tests schreiben** — `test/unit/editor-draft.test.ts` erweitern:

```ts
it("Datum und Tageszahl bleiben konsistent", () => {
  expect(dueDaysFrom("2066-03-01", "2066-03-15")).toBe("14");
  expect(dueDateFromDays("2066-03-01", "14")).toBe("2066-03-15");
  expect(dueDaysFrom("", "2066-03-15")).toBe("");        // ohne Rechnungsdatum keine Frist
  expect(dueDaysFrom("2066-03-15", "2066-03-01")).toBe(""); // Ziel vor Rechnungsdatum
  expect(dueDateFromDays("2066-02-27", "3")).toBe("2066-03-01"); // Schaltjahr 2066 = kein 29.2.
});
it("issueDate aendern zieht dueDate ueber die Tageszahl nach", () => {
  const days = dueDaysFrom("2066-03-01", "2066-03-15");
  expect(dueDateFromDays("2066-03-08", days)).toBe("2066-03-22");
});
it("toInvoicePayload sendet issueDate nur, wenn gesetzt", () => {
  const d = { ...emptyDraft("INVOICE"), customerId: "c1", issueDate: "" };
  expect(toInvoicePayload(d, false).issueDate).toBeUndefined();
  expect(toInvoicePayload({ ...d, issueDate: "2066-03-01" }, false).issueDate).toBe("2066-03-01");
});
it("Kopplung Leistungsdatum: an -> deliveryDate folgt issueDate, aus -> bleibt stehen", () => {
  let d = { ...emptyDraft("INVOICE"), issueDate: "2066-03-01", deliveryDateFollowsIssue: true, deliveryDate: "2066-03-01" };
  d = draftReducer(d, { type: "set", field: "issueDate", value: "2066-03-05" });
  expect(d.deliveryDate).toBe("2066-03-05");
  d = draftReducer({ ...d, deliveryDateFollowsIssue: false }, { type: "set", field: "issueDate", value: "2066-03-09" });
  expect(d.deliveryDate).toBe("2066-03-05");
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/editor-draft.test.ts`.

- [ ] **Step 3: Draft erweitern** — `DraftState` um `issueDate: string` und `deliveryDateFollowsIssue: boolean` (Default `false`; bei Neuanlage `true`, weil `DocumentSettings.autoDeliveryDate` serverseitig ohnehin so wirkt, siehe `invoice/create.ts:115`), `emptyDraft` und beide `draftFrom…` ergänzen. Dazu die zwei reinen Helfer:

```ts
// src/lib/editor/draft.ts — Ableitung zwischen Rechnungsdatum und Zahlungsziel (Phase 13b).
// Rein, ISO-Tagesstrings, Rechnung in UTC (Date.UTC) — eine lokale Zeitzone wuerde die
// Differenz an DST-Grenzen um einen Tag verschieben (dieselbe Begruendung wie utcDateOnly).
const DAY_MS = 24 * 60 * 60 * 1000;
function utcDay(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
/** Tage zwischen Rechnungs- und Faelligkeitsdatum; leer, wenn eines fehlt oder das Ziel davor liegt. */
export function dueDaysFrom(issueDate: string, dueDate: string): string {
  const a = utcDay(issueDate), b = utcDay(dueDate);
  if (a == null || b == null || b < a) return "";
  return String(Math.round((b - a) / DAY_MS));
}
/** Faelligkeitsdatum aus Rechnungsdatum + N Tagen (0..365); leer bei unvollstaendiger Eingabe. */
export function dueDateFromDays(issueDate: string, days: string): string {
  const a = utcDay(issueDate), n = Number(days.trim());
  if (a == null || !days.trim() || !Number.isInteger(n) || n < 0 || n > 365) return "";
  return new Date(a + n * DAY_MS).toISOString().slice(0, 10);
}
```
  Im Reducer bekommt `case "set"` **eine** zusätzliche Regel (kein zweiter Zustand):

```ts
// Phase 13b: das Leistungsdatum folgt dem Rechnungsdatum, solange der Nutzer die Kopplung
// nicht geloest hat. Bewusst hier und nicht in MetaBlock: sonst muesste jede weitere Stelle,
// die `issueDate` setzt (z. B. eine Vorlage in 13d), die Kopplung nachbauen.
if (action.field === "issueDate" && state.deliveryDateFollowsIssue) {
  return { ...state, issueDate: action.value as string, deliveryDate: action.value as string, dirty: true };
}
```
  `toInvoicePayload` bekommt `issueDate: d.issueDate || undefined` (`invoiceHeaderFields.issueDate` ist `z.coerce.date().optional()`; `updateDraftInvoice` schreibt es nur bei `!== undefined`, `invoice/update.ts:80`). `toDocumentPayload` **nicht** ändern: `createDocument` setzt `issueDate: now` fest (`document/create.ts:167`) und kennt kein Eingabefeld — ein Feld im Editor würde stillschweigend verworfen (Code schlägt Doku).
  `InvoiceInitialLike` + `rechnungen/[id]/bearbeiten/page.tsx`: `issueDate` als `yyyy-mm-dd` mitgeben.

- [ ] **Step 4: `MetaBlock` umbauen** (nur `mode === "INVOICE"`)
  - Neues Feld „Rechnungsdatum" (`type="date"`, Draft `issueDate`, Hinweis „leer = Datum der Anlage").
  - Unter „Leistungsdatum" ein Kontrollkästchen „entspricht dem Rechnungsdatum" (Draft `deliveryDateFollowsIssue`); beim Anhaken sofort `deliveryDate = issueDate` setzen.
  - „Fällig am" wird ein Paar: das bestehende Datumsfeld **und** ein Zahlenfeld „in N Tagen" (`min=0 max=365`). Datumsänderung → `dueDaysFrom`; Tagesänderung → `dueDateFromDays`. Die drei Schnellknöpfe (Z. 95-122) entfallen.
  - Vorbelegung von N beim **ersten** Öffnen einer Neuanlage: `selectedMethod?.paymentTermsDays` (bereits als Prop vorhanden), sonst leer — über `dispatch({ type: "replace", … })`, damit die Vorbelegung nicht `dirty` setzt (Muster: die Textvorlagen-Effekte in `DocumentEditor.tsx:160-215`).

```tsx
// src/components/editor/blocks/MetaBlock.tsx — "Faellig am" als Paar (ersetzt Z. 88-122).
// `issueDate || heute` als Bezug: `createDraftInvoice` setzt bei leerem Feld genau das
// (invoice/create.ts:102) — der Editor darf keine andere Frist zeigen als der gespeicherte Beleg.
const issueRef = draft.issueDate || new Date().toISOString().slice(0, 10);
<EditorField label="Fällig am">
  {(id) => (
    <div className="flex flex-wrap items-center gap-2">
      <input id={id} type="date" className={`${inputCls} flex-1`} value={draft.dueDate}
        onChange={(e) => dispatch({ type: "set", field: "dueDate", value: e.target.value })} />
      <span className="text-xs text-slate-500">in</span>
      <input type="number" min={0} max={365} className={`${inputCls} w-20`} value={dueDaysFrom(issueRef, draft.dueDate)}
        onChange={(e) => dispatch({ type: "set", field: "dueDate", value: dueDateFromDays(issueRef, e.target.value) })} />
      <span className="text-xs text-slate-500">Tagen</span>
    </div>
  )}
</EditorField>
```

- [ ] **Step 5: Gate + Commit** — Prüfkette, dann:
```bash
git add src/lib/editor/draft.ts src/components/editor/blocks/MetaBlock.tsx src/app/rechnungen test/unit/editor-draft.test.ts
git commit -s -m "feat(editor): Rechnungsdatum, gekoppeltes Leistungsdatum und Zahlungsziel in Tagen (Phase 13b, Task 2)"
```

### Task 3: Gesamtrabatt an den Positionen, Segmentumschalter, Produktauswahl

**Files:** Create `src/components/editor/blocks/DocumentAdjustmentFields.tsx` · Modify `src/components/editor/blocks/{MoreOptions,LineItemsEditor,LineRow}.tsx`, `src/components/editor/DocumentEditor.tsx`, `test/unit/editor-layout.test.ts`

**Ruling:** **Kein neues Datenfeld und kein zweiter Zustand.** `documentDiscountPermille`/`documentDiscountCents`/`documentCharge*` existieren seit Phase 4a in Prisma, Zod, Draft, MCP und im BG-20/BG-21-Mapping (`mapper.ts:158-167`). Die vier Felder werden aus `MoreOptions.tsx:139-158` **verschoben** (nicht kopiert) in eine eigene Komponente, die `DocumentEditor` direkt über `TotalsBlock` rendert. Brutto/Netto-Umschalter (`LineItemsEditor.tsx:118`) und Produktsuche (`LineRow` → `ProductPicker`) werden **nicht** neu gebaut, nur umplatziert.

- [ ] **Step 1: Failing test schreiben** — `test/unit/editor-layout.test.ts` erweitern:

```ts
const EDITOR = path.join(SRC, "components/editor");
const files = walk(EDITOR); // rekursiv alle .tsx (Helfer wie in test/unit/dialogs.test.ts)
it("die vier Beleg-Rabattfelder stehen in genau einer Datei", () => {
  for (const field of ["documentDiscountPercent", "documentDiscountAmount", "documentChargePercent", "documentChargeAmount"]) {
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(field)).map((f) => path.basename(f));
    expect({ field, hits }).toEqual({ field, hits: ["DocumentAdjustmentFields.tsx"] });
  }
});
it("Umschalter und Produktauswahl sitzen in der Positionskopfzeile", () => {
  const src = readFileSync(path.join(EDITOR, "blocks/LineItemsEditor.tsx"), "utf8");
  expect(src).toMatch(/aria-pressed/);            // Segmentumschalter statt Kontrollkaestchen
  expect(src).not.toMatch(/type="checkbox"/);
  expect(src).toContain("Produkt auswählen");
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/editor-layout.test.ts`.

- [ ] **Step 3: `DocumentAdjustmentFields` schreiben** — die vier `EditorField`-Blöcke plus „Grund" **wortgleich** aus `MoreOptions` übernehmen (`set(dispatch, …)`-Aufrufe unverändert), in `<div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">`, aufgeklappt über einen Link „+ Gesamtrabatt" (lokaler `useState`, initial `true`, sobald eines der vier Felder gefüllt ist — sonst versteckt der Editor eine bereits gesetzte Beleganpassung). In `DocumentEditor` zwischen `LineItemsEditor` und `TotalsBlock` einhängen, nur für `mode !== "DELIVERY_NOTE"` (dieselbe Bedingung wie `TotalsBlock`). Aus `MoreOptions` den Block ersatzlos entfernen.

- [ ] **Step 4: Segmentumschalter und Produktauswahl** — in der Kopfzeile von `LineItemsEditor` das Kontrollkästchen „Brutto anzeigen" durch einen Segmentumschalter ersetzen (zwei `<button type="button">` mit `aria-pressed`, Beschriftung „Preise: netto | brutto", dieselbe `dispatch({ type: "set", field: "grossDisplay", … })`-Aktion, Titel-Tooltip „Reine Anzeige — die Eingabe bleibt immer netto." bleibt). Neben „+ Position" ein „+ Produkt auswählen": legt über `addLineAfterLast` eine ITEM-Zeile an und setzt den Fokus in deren Produktsuche — dazu bekommt `LineRow` eine optionale Prop `autoFocusProduct?: boolean`, die den bestehenden `ProductPicker` beim Mount fokussiert (kein zweites Suchfeld).

- [ ] **Step 5: Gate + Commit** — Prüfkette, dann:
```bash
git add src/components/editor test/unit/editor-layout.test.ts
git commit -s -m "feat(editor): Gesamtrabatt an den Positionen, Segmentumschalter und Produktauswahl (Phase 13b, Task 3)"
```

### Task 4: Betreff im PDF  ⚠ Task-Review (GoBD-Darstellung festgeschriebener Belege)

**Files:** Create `test/integration/pdf-subject.test.ts` · Modify `src/lib/einvoice/types.ts:89`, `src/lib/einvoice/mapper.ts:306`, `src/domain/document/pdf-data.ts`, `src/domain/settings/preview-draft.ts:132,169`, `src/lib/pdf/layouts/{types,shared,standard,schlicht,klassik,modern}.ts`

**Interfaces:** `EInvoiceData.subject?: string | null` (BT-22 mit Subjektcode BT-21 `AAI`, siehe Task 5) · `MapInput.subject?: string | null` · `DocInput.subject?: string | null` · `KopfInput.subject?: string | null` · neu `drawSubject(frame: LayoutFrame, subject: string, y: number): number` in `layouts/shared.ts`.

**Ruling:** Gezeichnet wird über **eine** Hilfsfunktion in `layouts/shared.ts`, aufgerufen aus den **vier** `drawKopf`-Implementierungen (`standard`, `schlicht`, `klassik`, `modern`) — `blau`/`schwarz`/`kompakt` erben sie, weil `styledLayout` (`layouts/styled.ts:31`) `standardLayout.drawKopf` weiterreicht. Der Betreff steht direkt über dem Kopftext (`input.intro`), fett, in der Grundschriftgröße des Layouts. Lieferscheine bleiben unberührt (`DeliveryNote` hat kein `subject`).

- [ ] **Step 1: Failing test schreiben** — `test/integration/pdf-subject.test.ts` (Muster: `test/integration/pdf-theme.test.ts`, Text über `pdf-parse`):

```ts
it("druckt den Betreff genau einmal und ueber dem Kopftext", async () => {
  const text = await pdfText(await renderInvoicePdf({ ...base, subject: "Wartung Anlage 4711", headerText: "Guten Tag," }, theme));
  expect(text.match(/Wartung Anlage 4711/g)).toHaveLength(1);
  expect(text.indexOf("Wartung Anlage 4711")).toBeLessThan(text.indexOf("Guten Tag,"));
});
it("ohne Betreff bleibt die Ausgabe byte-gleich zur Referenz", async () => {
  const a = await renderInvoicePdf({ ...base, subject: null }, { ...theme, compress: false });
  const b = await renderInvoicePdf(base, { ...theme, compress: false });
  expect(a.equals(b)).toBe(true);
});
it("ein 200 Zeichen langer Betreff bricht um und verdraengt den Adressblock nicht", async () => {
  const text = await pdfText(await renderInvoicePdf({ ...base, subject: "L".repeat(200) }, theme));
  expect(text).toContain(base.buyer.name);
  expect(text).toContain("Rechnungsdatum");
});
it("gilt fuer alle sieben Layouts", async () => {
  for (const id of LAYOUT_IDS) {
    const text = await pdfText(await renderInvoicePdf({ ...base, subject: "Betreffprobe" }, { ...theme, layoutId: id }));
    expect({ id, hit: text.includes("Betreffprobe") }).toEqual({ id, hit: true });
  }
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/pdf-subject.test.ts`.

- [ ] **Step 3: `subject` durch die Datenschicht ziehen**
  - `types.ts:89` — `subject?: string | null;` mit Kommentar „BT-22 (Note) mit Subjektcode BT-21 `AAI`; im PDF eigene Betreffzeile".
  - `mapper.ts` — `MapInput.subject?: string | null` und im Rückgabeobjekt (neben `notes: invoice.notes`, Z. 306) `subject: invoice.subject ?? null`. `loadEInvoiceData` (`einvoice/load.ts:72`) spreadet die ganze Rechnung ⇒ **keine** Änderung nötig.
  - `pdf-data.ts` — `DocInput.subject?: string | null` und `subject: q.subject ?? null` in `buildDocEInvoiceData`. Die Routen `/api/documents/[id]/pdf`, `src/api/files.ts:101` und `app/angebot/[token]` reichen das Quote-Objekt direkt durch ⇒ keine Änderung.
  - `preview-draft.ts` — in **beiden** Vorschaupfaden (Z. 132 und 169) `data.subject = payload.subject ?? null` setzen, damit die Vorschau im Editor (`PreviewSheet`) den Betreff zeigt. `toInvoicePayload`/`toDocumentPayload` senden ihn bereits.

- [ ] **Step 4: `drawSubject` schreiben und in vier `drawKopf` aufrufen**

```ts
// src/lib/pdf/layouts/shared.ts
/**
 * Betreffzeile (Phase 13b): fett, Grundschriftgroesse des Layouts, volle Textbreite,
 * direkt ueber dem Kopftext. Genau EINE Implementierung fuer alle sieben Layouts —
 * `standard`, `schlicht`, `klassik`, `modern` rufen sie in ihrem `drawKopf` auf,
 * `blau`/`schwarz`/`kompakt` erben ueber styledLayout den Standard-Kopf.
 * Liefert die neue y-Position (pdfkit kann bei langem Betreff selbst umbrechen).
 */
export function drawSubject(frame: LayoutFrame, subject: string, y: number): number {
  const { doc, left, right, base } = frame;
  doc.font("Helvetica-Bold").fontSize(base).fillColor("#000").text(subject, left, y, { width: right - left });
  doc.font("Helvetica");
  return doc.y + 8;
}
```
  In `standard.ts:26`, `schlicht.ts:40`, `klassik.ts:28` und `modern.ts:41` jeweils **unmittelbar vor** dem `if (input.intro)`-Block einfügen: `if (input.subject) y = drawSubject(frame, input.subject, y);`. `KopfInput` (`layouts/types.ts:36`) bekommt `subject?: string | null`, `invoice-pdf.ts:233-241` reicht `subject: data.subject` mit. `delivery-note-pdf.ts:199` bleibt unverändert.

- [ ] **Step 5: Gate + Commit** — Prüfkette, dann:
```bash
git add src/lib/einvoice/types.ts src/lib/einvoice/mapper.ts src/domain/document/pdf-data.ts src/domain/settings/preview-draft.ts src/lib/pdf/layouts test/integration/pdf-subject.test.ts
git commit -s -m "feat(pdf): Betreff als eigene Zeile in allen Layouts (Phase 13b, Task 4)"
```

### Task 5: Betreff in XRechnung und ZUGFeRD/CII  ⚠ Task-Review (E-Rechnung, CI-Gate)

**Files:** Modify `src/lib/einvoice/xrechnung.ts:183`, `src/lib/einvoice/cii.ts:122`, `scripts/generate-sample-xrechnung.ts`, `scripts/validate-erechnung.ts:106`, `test/unit/einvoice.test.ts`

**Ruling (Spec, bindend):** EN 16931 kennt kein eigenes BT für „Betreff". Semantisch korrekt ist **BT-22** (Note) mit **BT-21** Subjektcode `AAI` („General information", UNTDID 4451). UBL bildet BT-21 als Präfix `#AAI#` im `cbc:Note` ab, CII als `ram:IncludedNote/ram:SubjectCode`. Beide Elemente sind mehrfach zulässig — die bestehenden Notes (Pflichthinweis, Abzugsaufstellung der Schlussrechnung, § 14b-Hinweis) bleiben **eigene** Elemente und werden nicht zusammengefasst. **Beanstandet der KoSIT-Validator die Konstruktion, entfällt das XML-Mapping ersatzlos** (Betreff bleibt PDF-only, Task 4), die Fixture wird entfernt — kein Herunterstufen auf „WARNING".

- [ ] **Step 1: Failing tests schreiben** — `test/unit/einvoice.test.ts` erweitern:

```ts
it("UBL: Betreff als zusaetzliches cbc:Note mit #AAI#-Praefix", () => {
  const xml = buildXRechnungUBL({ ...base, notes: "Danke.", subject: "Wartung Anlage 4711" });
  expect(xml).toContain("<cbc:Note>#AAI#Wartung Anlage 4711</cbc:Note>");
  expect(xml).toContain("<cbc:Note>Danke.</cbc:Note>");        // Bestandsnote unveraendert
  expect(xml.match(/<cbc:Note>/g)).toHaveLength(2);
});
it("CII: ram:IncludedNote mit ram:Content vor ram:SubjectCode", () => {
  const xml = buildFacturXCII({ ...base, subject: "Wartung Anlage 4711" });
  expect(xml).toMatch(/<ram:IncludedNote><ram:Content>Wartung Anlage 4711<\/ram:Content><ram:SubjectCode>AAI<\/ram:SubjectCode><\/ram:IncludedNote>/);
});
it("ohne Betreff entsteht kein zusaetzliches Element", () => {
  expect(buildXRechnungUBL(base)).toBe(buildXRechnungUBL({ ...base, subject: null }));
  expect(buildFacturXCII(base)).toBe(buildFacturXCII({ ...base, subject: "" }));
});
it("Pflichthinweis und § 14b-Note bleiben eigene Elemente", () => {
  const xml = buildXRechnungUBL({ ...base, subject: "S", consumerRetentionHint: true });
  expect(xml.match(/<cbc:Note>/g)).toHaveLength(3); // notes + Betreff + Aufbewahrungshinweis
});
```

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/unit/einvoice.test.ts`.

- [ ] **Step 3: Builder ergänzen**
  - `xrechnung.ts` direkt nach Z. 183 (`if (data.notes) …`): `if (data.subject) root.ele("cbc:Note").txt(\`#AAI#${data.subject}\`).up();` mit Kommentar „BT-22 mit Subjektcode BT-21 `AAI` (UNTDID 4451) — XRechnung kodiert BT-21 als `#CODE#`-Präfix im `cbc:Note`; mehrere `cbc:Note` sind laut UBL-XSD zulässig (siehe Abzugsaufstellung/Aufbewahrungshinweis darunter)."
  - `cii.ts` direkt nach Z. 122: `if (data.subject) doc.ele("ram:IncludedNote").ele("ram:Content").txt(data.subject).up().ele("ram:SubjectCode").txt("AAI").up().up();` mit Kommentar zur **XSD-Reihenfolge** (`ram:ContentCode?`, `ram:Content*`, `ram:SubjectCode?` — `Content` steht **vor** `SubjectCode`; eine vertauschte Reihenfolge scheitert bereits an der Schema-, nicht erst an der Schematron-Prüfung).
  - Reihenfolge in beiden Buildern: bestehende `notes` zuerst, dann Betreff, dann Abzugsaufstellung, dann Aufbewahrungshinweis — bestehende Fixtures bleiben damit byte-gleich.

- [ ] **Step 4: CI-Fixture `betreff-note`** — `scripts/generate-sample-xrechnung.ts`: `buildSample`-Optionen um `subject?: string` erweitern (durchreichen an das erzeugte `EInvoiceData`), neue Fabrik nach dem Muster von `reverseChargeAe`:

```ts
// 21) Phase 13b — Betreff als BT-22-Note mit Subjektcode BT-21 "AAI" (UNTDID 4451).
const betreffNote = () =>
  buildSample({
    number: "RE-2042-0001",
    subject: "Wartung Heizungsanlage, Objekt Lindenstr. 5",
    notes: "Vielen Dank für Ihren Auftrag.",
    lines: [{ description: "Wartung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 48000, taxRate: 19, taxCategory: "S" }],
  });
```
  In `SAMPLES` als `"betreff-note": betreffNote` eintragen und in `scripts/validate-erechnung.ts` `SAMPLE_NAMES` (Z. 106-127) am Ende ergänzen — die Fixture läuft dann automatisch als UBL **und** CII (dann 21 Fixtures / 41 XML-Dateien; den Zählkommentar Z. 103-105 mitpflegen).

- [ ] **Step 5: CI-Gate fahren und entscheiden** — `npm run validate:erechnung` (Vordergrund, Timeout 600000 ms; braucht `unzip` für die KoSIT-Konfiguration). **Alle** Fixtures müssen bestehen. Beanstandet der Validator `betreff-note`: die Meldung wörtlich in den Task-Report übernehmen, dann Step 3 + Step 4 vollständig zurücknehmen (Fixture entfernen, `subject` bleibt im PDF und in `EInvoiceData`, die Unit-Tests aus Step 1 auf „kein zusätzliches Element" umstellen) und die Entscheidung in `docs/LIMITATIONEN.md` festhalten. Keine Zwischenlösung.

- [ ] **Step 6: Gate + Commit** — Prüfkette **plus** `npm run validate:erechnung`, dann:
```bash
git add src/lib/einvoice scripts test/unit/einvoice.test.ts
git commit -s -m "feat(erechnung): Betreff als BT-22-Note mit Subjektcode AAI in UBL und CII (Phase 13b, Task 5)"
```

### Task 6: Anhänge im Entwurf  ⚠ Task-Review (neuer Schreibpfad)

**Files:** Create `test/integration/editor-attachments.test.ts` · Modify `src/components/AttachmentPanel.tsx:42-70`, `src/components/editor/blocks/AttachmentsBlock.tsx`, `src/components/editor/DocumentEditor.tsx`

**Ruling:** **Keine neue Upload-Route und kein schwebender Datensatz.** Wählt der Nutzer im Neuanlage-Editor die erste Datei, speichert der Editor zuerst den Entwurf über den **bestehenden** Weg (`POST /api/invoices` bzw. `/api/documents`, dieselbe Validierung), übernimmt die zurückgegebene Id in den Draft und lädt danach über die **bestehende** Route `POST /api/attachments` hoch. Scheitert das Speichern (Validierung), entsteht **kein** Beleg und **kein** Anhang; der heutige Hinweistext erscheint als Fehlermeldung, die Datei wird verworfen. `DocumentAttachment.@@unique([orgId, sha256, docType, docId])` und die orgId-Bindung bleiben unverändert.

**Interfaces:** `AttachmentPanel` bekommt `docId: string` (darf jetzt `""` sein) und optional `ensureDocId?: () => Promise<string | null>`; `DocumentEditor.save(opts?: { navigate?: boolean }): Promise<string | null>` liefert die Id des gespeicherten Belegs.

- [ ] **Step 1: Failing test schreiben** — `test/integration/editor-attachments.test.ts` (Jahr **2067**) prüft die **Domänenwirkung** der Reihenfolge, nicht die React-Mechanik (Muster: `test/integration/attachments-route.test.ts`):

```ts
it("gueltiger Entwurf: genau ein Beleg und ein Anhang, beide mit derselben orgId", async () => {
  const before = await dbInternal.invoice.count({ where: { orgId } });
  const res = await POST_invoices(payload);                 // bestehender Speicherweg
  expect(res.status).toBe(201);
  const { id } = await res.json();
  const up = await POST_attachments(formDataWith({ docType: "INVOICE", docId: id, file: pdfFixture }));
  expect(up.status).toBe(201);
  expect(await dbInternal.invoice.count({ where: { orgId } })).toBe(before + 1);
  const att = await dbInternal.documentAttachment.findMany({ where: { orgId, docType: "INVOICE", docId: id } });
  expect(att).toHaveLength(1);
});
it("ungueltiger Entwurf: kein Beleg und kein Anhang", async () => {
  const beforeInv = await dbInternal.invoice.count({ where: { orgId } });
  const beforeAtt = await dbInternal.documentAttachment.count({ where: { orgId } });
  expect((await POST_invoices({ ...payload, customerId: "" })).status).toBe(400);
  expect(await dbInternal.invoice.count({ where: { orgId } })).toBe(beforeInv);
  expect(await dbInternal.documentAttachment.count({ where: { orgId } })).toBe(beforeAtt);
});
```
  Dazu als Regression: zweimal dieselbe Datei an denselben Beleg ⇒ `@@unique([orgId, sha256, docType, docId])` greift (bestehendes Verhalten aus `test/integration/attachments.test.ts`, nur referenziert, nicht neu gebaut).

- [ ] **Step 2: rot** — `TZ=UTC npx vitest run test/integration/editor-attachments.test.ts`.

- [ ] **Step 3: `save` mit Rückgabewert** — in `DocumentEditor.tsx` `save()` zu `async function save(opts: { navigate?: boolean } = {}): Promise<string | null>` erweitern: bei Fehlern weiterhin `setError` und `return null`; bei Erfolg
```ts
const id = isEdit ? draft.id! : (await res.json() as { id: string }).id;
// `replace` statt `set` — `set` setzt IMMER dirty:true, und ein gerade gespeicherter
// Entwurf ist nicht "ungespeichert" (dasselbe Argument wie bei den Vorbelegungs-Effekten).
dispatch({ type: "replace", state: { ...draftRef.current, id, dirty: false } });
if (opts.navigate !== false) { router.push(`${DETAIL_BASE_PATH[mode]}/${id}`); router.refresh(); }
return id;
```
  Der bestehende Aufruf im `EditorHeader` bleibt `void save()` (navigiert wie bisher).

- [ ] **Step 4: `AttachmentPanel` und `AttachmentsBlock`** — in `AttachmentPanel.upload` (Z. 42) vor dem `FormData`-Aufbau:
```ts
// Phase 13b: im Neuanlage-Editor gibt es noch keine docId — der Aufrufer speichert den
// Entwurf ueber seinen bestehenden Speicherweg und liefert die neue Id. Schlaegt das fehl
// (Validierung), bricht der Upload ab: kein Beleg, kein Anhang, keine zweite Route.
const targetId = docId || (ensureDocId ? await ensureDocId() : null);
if (!targetId) { setError("Bitte zuerst die Pflichtfelder ausfüllen — der Entwurf konnte nicht gespeichert werden."); setUploading(false); return; }
```
  und `fd.set("docId", targetId)`. `AttachmentsBlock` rendert den `AttachmentPanel` künftig **immer** (nicht nur bei `isEdit`), mit `docId={docId ?? ""}` und `ensureDocId={onEnsureDocId}`; `DocumentEditor` übergibt `onEnsureDocId={() => save({ navigate: false })}`. Der bisherige Hinweistext entfällt als Dauerzustand und lebt nur noch als Fehlermeldung weiter.

- [ ] **Step 5: Gate + Commit** — Prüfkette, dann:
```bash
git add src/components/AttachmentPanel.tsx src/components/editor test/integration/editor-attachments.test.ts
git commit -s -m "feat(editor): Anhaenge bereits im neuen Entwurf, ohne zweite Upload-Route (Phase 13b, Task 6)"
```

### Task 7: Unsaved-Guard der Befehlspalette, Doku, Smoke, Gesamtprüfung

*(letzter Task der Teilphase — kein eigenes Task-Review, Abnahme im Abschluss-Review)*

**Files:** `src/components/shell/{ShellProvider,CommandPalette}.tsx:149`, `src/components/editor/DocumentEditor.tsx`, `docs/{ANLEITUNG,LIMITATIONEN,ARCHITEKTUR}.md`

- [ ] **Step 1: Unsaved-Guard** (Backlog-Punkt 12e) — `ShellProvider` bekommt `unsavedRef: MutableRefObject<boolean>` plus `setUnsaved(v: boolean)`; `DocumentEditor` meldet `draft.dirty` in einem Effekt (und beim Unmount `false`). `CommandPalette.go()` (Z. 149-151) fragt vor `router.push` ab:
```ts
// Die Befehlspalette navigiert per router.push und wird deshalb NICHT vom Klick-Abfangjaeger
// in EditorHeader (a[href]-Capture) erfasst — ohne diese Abfrage verliert ein Sprung aus der
// Palette den ungespeicherten Entwurf kommentarlos (Backlog 12e).
if (unsavedRef.current && !confirm("Der Beleg hat ungespeicherte Änderungen. Trotzdem wechseln?")) return;
```
  Test (`test/unit/editor-layout.test.ts`): `CommandPalette.tsx` enthält vor `router.push` eine `unsavedRef`-Abfrage, `ShellProvider.tsx` exportiert `setUnsaved`.
- [ ] **Step 2: Doku** (Code schlägt Doku — jede Formulierung gegen die Implementierung prüfen)
  - `ANLEITUNG.md`, Abschnitt Belege anlegen: Rechnungsdatum, „Leistungsdatum entspricht dem Rechnungsdatum", Zahlungsziel als Datum **oder** Tageszahl, „+ Gesamtrabatt" unter den Positionen, Segmentumschalter netto/brutto, Anhänge schon im neuen Entwurf (der Beleg wird dabei als Entwurf gespeichert), Betreff erscheint im PDF und in der E-Rechnung. `ARCHITEKTUR.md`: `drawSubject`, `EInvoiceData.subject`, `dueDaysFrom`/`dueDateFromDays`, `AttachmentPanel.ensureDocId`.
  - `LIMITATIONEN.md`, neuer Absatz „Editor und Betreff (Phase 13b)": (1) „Der Betreff wird ab dieser Version auf **allen** PDFs gedruckt, deren Betreff-Feld gefüllt ist — auch auf bereits festgeschriebenen Belegen. Das ist Darstellung, nicht Inhalt (Ruling analog Phase 7/12a); die Hash-Kette bleibt unberührt, ein neu erzeugtes PDF eines Altbelegs sieht dadurch anders aus als beim Festschreiben." (2) Der Betreff geht als BT-22-Note mit Subjektcode `AAI` ins XML — **oder**, falls der KoSIT-Validator das beanstandet hat, gar nicht (Task 5, Step 5: den tatsächlichen Ausgang eintragen). (3) „Ein Anhang im neuen Entwurf speichert den Beleg — danach existiert eine Entwurfs-Belegnummer bzw. ein Entwurfsdatensatz, auch wenn der Nutzer den Editor verlässt."
- [ ] **Step 3: Playwright-Smoke** (Skill `webapp-testing`; `npm run dev` im Vordergrund, Seed-Login `admin@example.com` / `demo1234`; Screenshots einzeln nach `<scratchpad>/ui-previews/13b-*.png`): (1) `/rechnungen/neu`: alle Blöcke untereinander, Felder spürbar größer, Positionstabelle bleibt in einer Zeile. (2) Rechnungsdatum ändern → Leistungsdatum zieht nach; Haken entfernen → bleibt stehen. (3) „in 14 Tagen" eintippen → „Fällig am" springt; Datum ändern → Tageszahl springt zurück. (4) „+ Gesamtrabatt" → Rabatt 10 % → `TotalsBlock` zeigt die Rabattzeile, Vorschau ebenfalls. (5) Betreff füllen, Datei anhängen **vor** dem ersten Speichern → Beleg wird angelegt, Datei erscheint in der Liste; Vorschau und PDF zeigen den Betreff über dem Kopftext. (6) Aus dem geänderten Editor die Befehlspalette öffnen und irgendwohin springen → Rückfrage erscheint. Konsolenfehler protokollieren; kein CI-Gate.
- [ ] **Step 4: Gesamtprüfung** — `npm run typecheck && npm run lint && TZ=UTC npm test && npm run build && npm run validate:erechnung && npm run api:check` (Vordergrund, Timeout 600000 ms). `scripts/test-postgres-migrations.sh` **nicht** nötig: Phase 13b ändert kein Schema.
- [ ] **Step 5: Commit**
```bash
git add src/components/shell src/components/editor docs && git commit -s -m "feat(editor): Unsaved-Guard der Befehlspalette und Doku (Phase 13b, Task 7)"
```

## Abschluss-Review (opus) — Prüfpunkte

1. **Keine Schemaänderung:** `git diff main --stat -- prisma/` leer; `src/lib/db.ts` unverändert; kein Schreibpfad berührt eine Spalte eines festgeschriebenen Belegs.
2. **Betreff-Datenweg:** `grep -rn "subject" src/lib/einvoice src/lib/pdf src/domain/document/pdf-data.ts` zeigt genau die geplanten Stellen; `loadEInvoiceData` brauchte keine Änderung (Spread); die Vorschau (`preview-draft.ts`) zeigt denselben Betreff wie das echte PDF.
3. **PDF:** `drawSubject` existiert **einmal**; alle vier `drawKopf` rufen sie vor `input.intro`; leerer Betreff ⇒ byte-gleiche Ausgabe (Test); alle sieben Layouts drucken ihn; `delivery-note-pdf.ts` unverändert.
4. **E-Rechnung:** `npm run validate:erechnung` grün für **alle** Fixtures inklusive `betreff-note` (UBL **und** CII) — oder das Mapping ist vollständig entfernt und LIMITATIONEN sagt das. Kein „WARNING"-Kompromiss. Bestehende Fixtures byte-gleich (keine umsortierten Notes). `ram:Content` steht vor `ram:SubjectCode`.
5. **Kein zweites Rabattkonzept:** `grep -rn "documentDiscountPercent" src/components/editor` trifft genau eine Datei; das BG-20/BG-21-Mapping (`mapper.ts:158-167`) ist unverändert; Rabatt und AllowanceCharge-Mapping werden weiterhin gemeinsam ausgeliefert.
6. **Datumsableitung:** `dueDaysFrom`/`dueDateFromDays` sind rein und in UTC gerechnet; gespeichert wird weiterhin nur `dueDate`; `issueDate` geht nur bei gefülltem Feld in den Payload; `toDocumentPayload` sendet **kein** `issueDate` (der Server setzt es fest).
7. **Anhänge:** genau eine Upload-Route (`/api/attachments`); scheitert die Validierung, entsteht kein Beleg und kein Anhang (Test); `@@unique([orgId, sha256, docType, docId])` unverändert; `save({ navigate: false })` setzt `dirty: false` über `replace`, nicht über `set`.
8. **Interne Notizen (§48):** weiterhin in keinem PDF, XML, Mailtext und keinem öffentlichen Angebotslink — Bestandstests grün, `PreviewSheet.tsx:71` unverändert.
9. **Oberfläche:** kein `md:grid-cols-2` mehr im `DocumentEditor`; `inputDenseCls` nur in der Positionstabelle; `EditorHeader` weiterhin `sticky top-0`; jeder neue Schalter hat eine Backend-Wirkung (keine Attrappe).
10. **Smoke:** Screenshots zeigen den einspaltigen Editor, gekoppelte Datumsfelder, Gesamtrabatt an den Positionen, Anhang im Entwurf und den Betreff im PDF. Betreiberfrage: „Ist der Editor jetzt so bedienbar wie erwartet — und steht der Betreff an der richtigen Stelle im Beleg?"
