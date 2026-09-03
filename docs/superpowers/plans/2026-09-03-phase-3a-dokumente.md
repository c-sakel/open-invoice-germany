# Phase 3a — Dokumentkette, Angebot/AB-Status, Lieferscheine, Dokumenttexte: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein zusammenhängender Auftragsworkflow Angebot → Auftragsbestätigung → Lieferschein (auch Teillieferung) → Rechnung mit sichtbarer Dokumentkette auf jeder Detailseite, echten Angebots-/AB-/Lieferschein-Status, Kopf-/Fußtexten aus Vorlagen, Lieferschein-PDF und Versand, Duplizieren und Archivieren — als Backend + UI + MCP.

**Architecture:** Zustandsmaschine und Konvertierungen als reine Domain-Module (`src/domain/document/*`, `src/domain/delivery-note/*`), Kette aus `DocumentRelation` (Phase 1) per Baumaufbau, Texte aus `TextTemplate` (Phase 1) beim Anlegen kopiert und beim PDF mit der Phase-2-Engine gerendert; UI folgt den bestehenden Mustern (Server Actions mit `ActionResult`, API-Routen mit Zod, Client-Fetch-Komponenten).

**Tech Stack:** Next.js 16, TypeScript strict, Prisma 6.19.3 (SQLite + Postgres, zwei Schemas), Zod 4, vitest, pdfkit (bestehend).

**Spec:** `docs/superpowers/specs/2026-09-03-phase-3-dokumente-design.md` (Branch `specs`; Kopie `scratchpad/plan/2026-09-03-phase-3-dokumente-design.md`). Dieser Plan ist **3a**; die Online-Annahme (3b) folgt in einem eigenen Plan.

## Global Constraints

- Keine Prisma-Enums, kein Json-Typ; Geld Integer-Cent, Mengen Integer-Milliunits; Zod an jeder Boundary (Route, Action, MCP) **und** Domain-Funktionen parsen ihre Eingabe selbst (Ruling Phase 2, Lastenheft 55).
- Beide Schemas byte-gleich bis auf Provider; Migrationen in beiden Dialekten, additiv, idempotent; Backfill mit `WHERE`-Bedingung.
- GoBD: festgeschriebene Rechnungen unveränderbar; jede Statusänderung/Konvertierung mit `appendChangeLog(tx, …)` in derselben Transaktion; Relationen nur über `linkDocuments(tx, …)`.
- Snapshot-Regel (Phase 0): Angebote/AB/Lieferscheine tragen Snapshots; beim Wechsel nach SENT wird der Buyer-Snapshot mit Ansprechpartner/Adresse eingefroren, falls noch nicht vorhanden (`snapshotSource: "SENT"` neu, Zod `SnapshotSource` erweitern).
- `internalNotes` erscheinen nie in PDF, Mail, Kette.
- Deutsche UI-Texte und Kommentare; Commit-Messages ohne Umlaute; `git commit -s` mit Trailern.
- Prüfkette vor jedem Task-Abschluss: `npm run typecheck && npm run lint && npm test && npm run build && npm run validate:erechnung`.
- Tests gegen `prisma/test.db`; `Invoice.number` ist global unique → neue Testdateien nutzen `FIX_DATE` im Jahr **2031** (3a) bzw. 2032 (3b).
- Bestehende Funktionen erweitern, nicht parallel neu bauen (Lastenheft 1.4): `convertDocumentToInvoice` bleibt und wird von der generischen Konvertierung aufgerufen; `createDeliveryNote` wird erweitert.

---

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `prisma/schema*.prisma`, Migration `phase3a_documents` (beide Dialekte) | Felder an Quote/DeliveryNote/DeliveryNoteLine/Invoice, Backfill CONVERTED→ACCEPTED |
| `src/schemas/index.ts` | `QuoteStatus`, `DeliveryNoteStatus`, `RelationType` + DUPLICATED_FROM, `SnapshotSource` + SENT, erweiterte `createDocumentSchema`/`updateDocumentSchema`/`createDeliveryNoteSchema`, `convertDocumentSchema`, `documentStatusActionSchema` |
| `src/domain/document/status.ts` | Zustandsmaschinen `transitionQuote`, `transitionDeliveryNote`; `markSent`, `markAccepted`, `markRejected`, `cancelDocument`, `archiveDocument` |
| `src/domain/document/billing-state.ts` | `billingStateFor(orgId, type, id)` → NONE/PARTIAL/FULL aus Relationen |
| `src/domain/document/chain.ts` | `buildDocumentChain(orgId, type, id)` → Baum inkl. Zahlungen |
| `src/domain/document/convert.ts` | `convertDocument(orgId, input, opts)` generisch; ruft `convertDocumentToInvoice` für → INVOICE |
| `src/domain/document/duplicate.ts` | `duplicateDocument(orgId, type, id, actor)` |
| `src/domain/document/update.ts` | `updateDraftDocument(orgId, id, input, actor)` (nur DRAFT) |
| `src/domain/delivery-note/quantities.ts` | `remainingQuantities(orgId, sourceType, sourceId)`; `assertNoOverDelivery` |
| `src/domain/delivery-note/create.ts` | erweitert: Quelle/Positionen mit `sourceLineId`, Kopf-/Fußtext, Preise optional, Relation DELIVERED_BY |
| `src/domain/text-template/defaults.ts`, `ensure.ts`, `pick.ts` | Standard-Dokumenttexte, Selbstheilung (in `ensureOrgMasterdata`), `pickTextTemplate(orgId, docType, position)` |
| `src/lib/pdf/delivery-note-pdf.ts` | `renderDeliveryNotePdf(data)` |
| `src/lib/pdf/invoice-pdf.ts`, `src/domain/document/pdf-data.ts`, `src/lib/einvoice/mapper.ts`/`types.ts` | `headerText`/`footerText` im PDF (gerendert mit `renderTemplate`) |
| `src/domain/email/attachments.ts`, `send.ts` | DELIVERY_NOTE-PDF als Anhang; nach SENT-Erfolg `markSent` für ANGEBOT/AB/LS |
| `src/app/api/documents/[id]/{convert,status,duplicate}/route.ts`, `src/app/api/delivery-notes/route.ts`, `[id]/pdf/route.ts`, `[id]/status/route.ts`, `src/app/api/documents/[id]/route.ts` (PATCH) | Routen mit Zod |
| `src/app/actions/text-templates.ts` | CRUD Dokumenttexte |
| `src/components/{DocumentChain,DocumentActions,ConvertMenu,DeliveryNoteForm,RemainingQuantities}.tsx`, `src/components/forms/TextTemplateForm.tsx` | UI |
| `src/app/dokumente/[id]/page.tsx`, `src/app/dokumente/[id]/bearbeiten/page.tsx`, `src/app/dokumente/page.tsx`, `src/app/lieferscheine/{page,neu/page,[id]/page}.tsx`, `src/app/rechnungen/[id]/page.tsx`, `src/app/einstellungen/textvorlagen/**`, `src/app/layout.tsx` (Nav „Lieferscheine") | Seiten |
| `src/mcp/server.ts` | Tools `convert_document`, `create_delivery_note`, `set_document_status`, `duplicate_document` |
| Tests | `test/unit/document-status.test.ts`, `test/unit/text-template.test.ts`, `test/integration/document-flow.test.ts`, `test/unit/delivery-note-pdf.test.ts` |
| Doku | `docs/LIMITATIONEN.md`, `docs/ARCHITEKTUR.md`, `README.md`, `scripts/test-postgres-migrations.sh` (Fall 6: CONVERTED→ACCEPTED) |

---

### Task 1: Schema, Migration, Zod

**Files:** beide Prisma-Schemas; Migrationen `phase3a_documents` (SQLite + Postgres); `src/schemas/index.ts`; Test `test/unit/document-schemas.test.ts`.

**Interfaces (Produces):**
- `Quote`: `subject String?`, `headerText String?`, `footerText String?`, `deliveryTerms String?`, `paymentTerms String?`, `customerReference String?`, `contactPersonId String?`, `billingAddressId String?`, `sentAt DateTime?`, `decidedAt DateTime?`, `decisionNote String?`, `archivedAt DateTime?`; Relationen `contactPerson ContactPerson?`, `billingAddress CustomerAddress?` (FK `onDelete: SetNull`).
- `DeliveryNote`: `headerText String?`, `footerText String?`, `showArticleNumber Boolean @default(true)`, `showDescription Boolean @default(true)`, `sentAt DateTime?`, `deliveredAt DateTime?`, `archivedAt DateTime?`, `sourceType String?`, `sourceId String?` (Hauptquelle des Belegs).
- `DeliveryNoteLine`: `sourceLineId String?`, `unitNetPriceCents Int?`, `taxRate Int?`.
- `Invoice`: `headerText String?`, `footerText String?`.
- Backfill (beide Dialekte): `UPDATE "Quote" SET status = 'ACCEPTED' WHERE status = 'CONVERTED';`
- Zod:

```ts
export const QuoteStatus = z.enum(["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"]);
export const DeliveryNoteStatus = z.enum(["DRAFT", "CREATED", "SENT", "DELIVERED", "CANCELLED"]); // INVOICED wird abgeleitet
export const BillingState = z.enum(["NONE", "PARTIAL", "FULL"]);
export const RelationType = z.enum([...bisher, "DUPLICATED_FROM"]);
export const SnapshotSource = z.enum([...bisher, "SENT"]);

const documentTextFields = {
  subject: z.string().max(200).optional(),
  headerText: z.string().max(5000).optional(),
  footerText: z.string().max(5000).optional(),
  deliveryTerms: z.string().max(2000).optional(),
  paymentTerms: z.string().max(2000).optional(),
  customerReference: z.string().max(200).optional(),
  contactPersonId: z.string().optional(),
  billingAddressId: z.string().optional(),
};
export const createDocumentSchema = z.object({ kind: DocumentKind, customerId: z.string().min(1), taxScheme: TaxScheme.default("REGULAR"), currency: z.string().length(3).default("EUR"), validUntil: z.coerce.date().optional(), notes: z.string().optional(), internalNotes: z.string().optional(), ...documentTextFields, lines: z.array(invoiceLineInputSchema).min(1) });
export const updateDocumentSchema = createDocumentSchema.omit({ kind: true }).partial().extend({ lines: z.array(invoiceLineInputSchema).min(1).optional() });

export const deliveryNoteLineInputSchema = z.object({ description: z.string().min(1), articleNumber: z.string().optional(), quantityMilli: z.number().int().positive(), unit: z.string().min(1), sourceLineId: z.string().optional(), unitNetPriceCents: z.number().int().optional(), taxRate: z.number().int().optional() });
export const createDeliveryNoteSchema = z.object({ customerId: z.string().min(1), sourceType: z.enum(["QUOTE", "INVOICE"]).optional(), sourceId: z.string().optional(), deliveryDate: z.coerce.date().optional(), shippingDate: z.coerce.date().optional(), showPrices: z.boolean().default(false), showTax: z.boolean().default(false), showArticleNumber: z.boolean().default(true), showDescription: z.boolean().default(true), headerText: z.string().max(5000).optional(), footerText: z.string().max(5000).optional(), notes: z.string().optional(), internalNotes: z.string().optional(), lines: z.array(deliveryNoteLineInputSchema).min(1) });

export const convertDocumentSchema = z.object({
  fromType: z.enum(["QUOTE", "INVOICE"]), fromId: z.string().min(1),
  toKind: z.enum(["AUFTRAGSBESTAETIGUNG", "INVOICE", "DELIVERY_NOTE"]),
  /** nur fuer DELIVERY_NOTE: Mengen je Quellposition (Default = Restmenge) */
  quantities: z.array(z.object({ sourceLineId: z.string().min(1), quantityMilli: z.number().int().nonnegative() })).optional(),
  deliveryDate: z.coerce.date().optional(),
});
export const documentStatusActionSchema = z.object({ action: z.enum(["MARK_SENT", "MARK_ACCEPTED", "MARK_REJECTED", "MARK_DELIVERED", "CANCEL", "ARCHIVE", "UNARCHIVE"]), note: z.string().max(1000).optional() });
```

- [ ] Schema in beiden Dateien ändern; `npx prisma migrate dev --create-only --name phase3a_documents`; Backfill-Statement in die SQLite-Migration anhängen; `migrate deploy` + `generate`.
- [ ] Postgres-Migration über den Wrapper (Container aus dem Testskript) oder abgeleitet; Backfill anhängen; Schema-Diff leer.
- [ ] Zod + Test (Schemas parsen Beispiele; `convertDocumentSchema` lehnt negative Mengen ab; Backfill-Migration enthält das UPDATE in beiden Dialekten — per Dateilesen im Test).
- [ ] Prüfkette; Commit `feat(docs): Schema und Zod fuer Angebots-/Lieferschein-Workflow`.

---

### Task 2: Zustandsmaschine, Abrechnungsstand, Dokumentkette (Domain, TDD)

**Files:** `src/domain/document/status.ts`, `billing-state.ts`, `chain.ts`; Test `test/unit/document-status.test.ts`, `test/integration/document-chain.test.ts`.

**Interfaces (Produces):**

```ts
// status.ts
export type QuoteStatus = z.infer<typeof QuoteStatus>; export type DeliveryNoteStatus = …;
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  DRAFT: ["SENT", "ACCEPTED", "REJECTED", "CANCELLED"],   // Annahme ohne Versand erlaubt (Ruling: Postversand/telefonisch)
  SENT: ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"],
  ACCEPTED: ["CANCELLED"], REJECTED: [], EXPIRED: ["SENT", "ACCEPTED"], CANCELLED: [],
};
export const DELIVERY_TRANSITIONS: Record<DeliveryNoteStatus, readonly DeliveryNoteStatus[]> = {
  DRAFT: ["CREATED", "CANCELLED"], CREATED: ["SENT", "DELIVERED", "CANCELLED"], SENT: ["DELIVERED", "CANCELLED"], DELIVERED: ["CANCELLED"], CANCELLED: [],
};
export class StatusTransitionError extends Error {}
export function assertTransition<S extends string>(table: Record<S, readonly S[]>, from: S, to: S): void;
export async function setQuoteStatus(orgId: string, quoteId: string, to: QuoteStatus, opts: { actor?: string; now?: Date; note?: string }): Promise<Quote>;
export async function setDeliveryNoteStatus(orgId: string, id: string, to: DeliveryNoteStatus, opts): Promise<DeliveryNote>;
export async function setArchived(orgId: string, type: "QUOTE" | "DELIVERY_NOTE", id: string, archived: boolean, actor: string): Promise<void>;
export function effectiveQuoteStatus(q: { status: string; validUntil: Date | null }, now = new Date()): QuoteStatus; // EXPIRED abgeleitet
```
`setQuoteStatus`: Transaktion; `assertTransition`; bei `SENT` `sentAt = now` und Snapshot einfrieren, falls `buyerSnapshotJson` null (Buyer-Snapshot inkl. `contactName` aus `contactPerson`, Adresse aus `billingAddress`, Quelle `"SENT"`); bei ACCEPTED/REJECTED `decidedAt`, `decisionNote`; ChangeLog `QUOTE`/`STATUS_<to>` mit `{ from, to, note }`. Analog Lieferschein (`sentAt`, `deliveredAt`).

```ts
// billing-state.ts
export async function billingStateFor(orgId: string, type: "QUOTE", id: string): Promise<{ state: BillingState; invoiceIds: string[] }>;
// FULL: mindestens eine CONVERTED_TO-Relation auf eine Rechnung, die nicht CANCELLED ist; PARTIAL: (Phase 5) PARTIAL_OF/DOWNPAYMENT_OF vorhanden ohne FINAL_FOR; NONE sonst.
// chain.ts
export interface ChainNode { type: "QUOTE" | "INVOICE" | "DELIVERY_NOTE" | "DUNNING" | "PAYMENT"; id: string; label: string; number: string | null; status: string; href: string; relation?: string; children: ChainNode[] }
export async function buildDocumentChain(orgId: string, type: RefType, id: string): Promise<{ root: ChainNode; currentId: string }>;
// Wurzel = am weitesten zurueckverfolgbarer Vorgaenger (ueber toId==id rueckwaerts, max 6 Ebenen), dann Baum vorwaerts (fromId==id), Zahlungen als Kinder der Rechnung; Zyklen per Set verhindern; Labels aus doc-type-labels.
```

- [ ] Tests zuerst: Übergangstabelle (DRAFT→ACCEPTED erlaubt, REJECTED terminal, CANCELLED terminal, CREATED→DRAFT verboten); `effectiveQuoteStatus` mit abgelaufenem `validUntil`; `setQuoteStatus` SENT friert Snapshot mit `contactName` ein und schreibt ChangeLog; Kette Angebot→AB→LS→Rechnung→Zahlung (Relationen per `linkDocuments` im Test angelegt) liefert Baum mit `currentId`; fremde Org → leere/geworfene Kette; Zyklus (A→B, B→A) terminiert.
- [ ] Implementierung; Prüfkette; Commit `feat(docs): Zustandsmaschine, Abrechnungsstand und Dokumentkette`.

---

### Task 3: Dokumenttexte, generische Konvertierung, Teillieferung, Duplizieren, Entwurf bearbeiten (Domain, TDD)

**Files:** `src/domain/text-template/{defaults,ensure,pick}.ts`; `src/domain/masterdata/ensure.ts` (+ Aufruf); `src/domain/document/{convert,duplicate,update}.ts`; `src/domain/delivery-note/{create,quantities}.ts`; `src/domain/document/create.ts` (Texte vorbelegen, neue Felder); Tests `test/unit/text-template.test.ts`, `test/integration/document-flow.test.ts`.

**Interfaces (Produces):**

```ts
// text-template/defaults.ts — neutrale deutsche Standardtexte je (docType, position), z. B.
export const DEFAULT_TEXT_TEMPLATES = [
  { docType: "ANGEBOT", position: "HEAD", name: "Standard", body: "Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:" },
  { docType: "ANGEBOT", position: "FOOT", name: "Standard", body: "Dieses Angebot ist gültig bis {{offer.validUntil}}. Wir freuen uns auf Ihren Auftrag." },
  { docType: "AUFTRAGSBESTAETIGUNG", position: "HEAD", … "Vielen Dank für Ihren Auftrag. Hiermit bestätigen wir:" }, { … FOOT: "Wir werden den Auftrag wie vereinbart ausführen." },
  { docType: "DELIVERY_NOTE", position: "HEAD", … "Wir liefern Ihnen hiermit folgende Positionen:" }, { … FOOT: "Bitte prüfen Sie die Lieferung auf Vollständigkeit." },
  { docType: "INVOICE", position: "HEAD", … "Wir erlauben uns, folgende Leistungen in Rechnung zu stellen:" }, { … FOOT: "Vielen Dank für Ihren Auftrag." },
  { docType: "ANGEBOT", position: "TERMS_DELIVERY", … "Lieferung nach Vereinbarung." }, { docType: "ANGEBOT", position: "TERMS_PAYMENT", … "Zahlbar innerhalb von 14 Tagen ohne Abzug." },
] as const;
// ensure.ts: ensureOrgTextTemplates(db, orgId) — Upsert ueber Unique (orgId, docType, position, name) — Unique in Task 1 ergaenzen!, isDefault nur wenn keiner fuer (docType, position)
// pick.ts: pickTextTemplate(orgId, docType, position) → string | null  (Default, sonst aelteste)
```
**Hinweis für Task 1:** `TextTemplate` braucht `@@unique([orgId, docType, position, name])` — in Task 1 mit aufnehmen (Plan-Ergänzung; Migration additiv).

```ts
// convert.ts
export async function convertDocument(orgId: string, rawInput: ConvertDocumentInput, opts: { actor?: string; now?: Date } = {}): Promise<{ type: "QUOTE" | "INVOICE" | "DELIVERY_NOTE"; id: string }>;
// QUOTE(ANGEBOT) → AUFTRAGSBESTAETIGUNG: neues Quote kind AB, Positionen + Texte kopiert (HEAD/FOOT der AB aus Vorlage, Terms vom Angebot), Relation CONVERTED_TO, Angebot bleibt in seinem Status (ACCEPTED empfohlen: wenn Status SENT/DRAFT → automatisch ACCEPTED setzen, Ruling), ChangeLog.
// QUOTE → INVOICE: bestehendes convertDocumentToInvoice (erweitert um headerText/footerText/paymentTerms-Uebernahme; setzt Quote NICHT mehr auf CONVERTED, sondern laesst Status und setzt convertedToInvoiceId weiter — Abrechnungsstand kommt aus der Relation)
// QUOTE|INVOICE → DELIVERY_NOTE: Positionen mit sourceLineId; Mengen = input.quantities oder Restmengen; assertNoOverDelivery; createDeliveryNote(...) mit sourceType/sourceId; Relation DELIVERED_BY (from=Quelle, to=Lieferschein).
// quantities.ts
export async function remainingQuantities(orgId: string, sourceType: "QUOTE" | "INVOICE", sourceId: string): Promise<Array<{ sourceLineId: string; description: string; unit: string; orderedMilli: number; deliveredMilli: number; remainingMilli: number }>>;
// geliefert = Summe DeliveryNoteLine.quantityMilli ueber Lieferscheine mit status != CANCELLED und sourceLineId
export class OverDeliveryError extends Error {}
// duplicate.ts
export async function duplicateDocument(orgId: string, type: "QUOTE" | "DELIVERY_NOTE" | "INVOICE", id: string, actor: string, now?: Date): Promise<{ type; id }>;
// neuer DRAFT ohne Nummer, issueDate=now, Texte/Positionen kopiert, kein Snapshot, Relation DUPLICATED_FROM (from=neu, to=alt), ChangeLog CREATE mit { duplicatedFrom }
// update.ts
export async function updateDraftDocument(orgId: string, id: string, rawInput: UpdateDocumentInput, actor: string): Promise<Quote>; // nur status DRAFT, Positionen ersetzen, Summen neu, ChangeLog UPDATE
```

- [ ] Tests zuerst (Kernfälle §54): Texte werden beim Anlegen vorbelegt und sind editierbar; Angebot→AB kopiert 2 Positionen, Relation, Angebot ACCEPTED; AB→Lieferschein 4 von 10 → Rest 6; zweiter LS 6 → Rest 0; dritter LS 1 → `OverDeliveryError`; stornierter LS zählt nicht; Rechnung→Lieferschein möglich; Duplizieren erzeugt DRAFT ohne Nummer + Relation; `updateDraftDocument` verweigert bei SENT; fremde Org überall → Fehler; ChangeLog-Kette gültig (`verifyChain`).
- [ ] Implementierung; `ensureOrgMasterdata` ruft `ensureOrgTextTemplates`; `createBusinessDocument` nimmt neue Felder + Vorlagen; Prüfkette; zwei Commits (`feat(docs): Standard-Dokumenttexte mit Selbstheilung`, `feat(docs): generische Konvertierung, Teillieferung, Duplizieren, Entwurf bearbeiten`).

---

### Task 4: PDFs und Mail-Anbindung

**Files:** `src/lib/pdf/delivery-note-pdf.ts`; `src/lib/einvoice/types.ts` (+ `headerText?`, `footerText?` an `EInvoiceData`), `mapper.ts`, `pdf-data.ts` (Felder + Rendern über `renderTemplate` mit `buildTemplateContext`-ähnlichem Minimalkontext — dafür `src/domain/email/context.ts` eine Funktion `buildDocumentTextContext(docType, doc, org, customer)` exportieren, die ohne DB arbeitet), `src/lib/pdf/invoice-pdf.ts` (Kopftext vor der Tabelle, Fußtext nach den Summen); `src/domain/email/attachments.ts` (DELIVERY_NOTE → PDF), `src/domain/email/send.ts` (nach SENT: `setQuoteStatus(...,"SENT")` für ANGEBOT/AB mit Status DRAFT, `setDeliveryNoteStatus(...,"SENT")` für CREATED — Fehler dabei nicht den Mailversand zurückrollen, nur loggen); Tests `test/unit/delivery-note-pdf.test.ts`, Erweiterung `email-context.test.ts`.

- [ ] `renderDeliveryNotePdf({ number, issueDate, deliveryDate, shippingDate, seller, buyer, lines[{pos, articleNumber?, description, quantityMilli, unit, unitNetPriceCents?, taxRate?}], showPrices, showTax, showArticleNumber, showDescription, headerText, footerText, sourceNumber? })` — Layout an `invoice-pdf.ts` angelehnt (Kopf, Adressblock, Titel „Lieferschein", Meta rechts, Tabelle, optional Summen netto/brutto, Fußtext). Test: Buffer beginnt mit `%PDF`; Text-Extraktion nicht nötig — stattdessen die Datenaufbereitung (`buildDeliveryNotePdfData`) testen: Preise nur bei `showPrices`, Artikelnummer-Spalte nur bei Flag.
- [ ] Kopf-/Fußtext in Rechnungs-/Dokument-PDF; Platzhalter gerendert; `internalNotes` nie.
- [ ] Anhang DELIVERY_NOTE; Versand setzt SENT (Test in `email.test.ts`: Angebot DRAFT → nach `sendDocumentEmail` Status SENT, `sentAt` gesetzt).
- [ ] Prüfkette + `npm run validate:erechnung` (E-Rechnung unverändert gültig — Kopf-/Fußtext gehen **nicht** ins XML, außer als BT-22 Note? **Ruling: nicht ins XML**); Commit `feat(docs): Lieferschein-PDF, Kopf- und Fusstexte im PDF, Versand setzt Status`.

---

### Task 5: Routen, Actions, UI, MCP

**Files:** siehe Dateistruktur.

**Routen (Zod, Org via `getActiveOrg`, Actor via `getCurrentUserId`):**
- `PATCH /api/documents/[id]` → `updateDraftDocument`.
- `POST /api/documents/[id]/convert` body `{ toKind, quantities?, deliveryDate? }` → `convertDocument` (bestehende Route erweitern; alter Aufruf ohne Body = `toKind: "INVOICE"` bleibt kompatibel).
- `POST /api/documents/[id]/status` body `documentStatusActionSchema` → Status/Archiv.
- `POST /api/documents/[id]/duplicate`.
- `GET /api/documents/[id]/remaining` → `remainingQuantities`.
- `POST /api/delivery-notes` (manuell), `GET /api/delivery-notes/[id]/pdf`, `POST /api/delivery-notes/[id]/status`, `POST /api/delivery-notes/[id]/duplicate`.

**UI:**
- `dokumente/[id]`: Kopf mit `StatusBadge` (QuoteStatus-Labels + EXPIRED abgeleitet + Abrechnungsstand-Badge), Felder (Betreff, Referenz, Ansprechpartner, Bedingungen), Kopf-/Fußtext, Positionen, `DocumentChain`, `DocumentActions` (Bearbeiten nur DRAFT, Als versendet, Annehmen/Ablehnen mit Notiz-Prompt im `<dialog>`, Stornieren, Archivieren, Duplizieren), `ConvertMenu` (AB erzeugen / Rechnung erzeugen / Lieferschein erzeugen → öffnet Mengen-Dialog mit Restmengen), `SendEmailDialog`, `EmailHistory`.
- `dokumente/[id]/bearbeiten`: `NewDocumentForm` um `initial`-Prop und PATCH-Modus erweitern (kein zweites Formular).
- `dokumente/neu` + `NewDocumentForm`: neue Felder (Betreff, Referenz, Ansprechpartner-Select aus `ContactPerson`, Rechnungsadresse-Select aus `CustomerAddress`, Kopf-/Fußtext vorbelegt per `GET /api/text-templates/pick?docType=&position=`, Liefer-/Zahlungsbedingungen).
- `dokumente` Liste: Statusspalte mit Badge, Filter „archivierte anzeigen".
- `lieferscheine`: Liste, `neu` (manuell, `DeliveryNoteForm`), `[id]` (Positionen, Flags, Kette, Statusaktionen, PDF, Versand, Verlauf, Duplizieren). Nav-Link in `layout.tsx`.
- `rechnungen/[id]`: `DocumentChain`, „Lieferschein erzeugen", Kopf-/Fußtext-Anzeige.
- `einstellungen/textvorlagen`: Tab in `SettingsTabs`, Liste je docType/position, Editor mit Vorschau (Sample-Kontext der Phase 2), Default setzen, löschen (Systemvorlage nur wenn andere Default).

**MCP** (`src/mcp/server.ts`): `convert_document`, `create_delivery_note`, `set_document_status`, `duplicate_document` — Zod-Schemas aus `@/schemas`, gleiche Domain-Funktionen.

- [ ] Routen + Actions + MCP (Commit `feat(docs): Routen, Actions und MCP-Tools fuer Dokumentworkflow`).
- [ ] UI (Commit `feat(docs): Dokumentkette, Statusaktionen, Lieferscheine und Textvorlagen im UI`). Manuelle Prüfung auf Port 3100: Angebot anlegen → AB erzeugen → Lieferschein 4/10 → zweiter 6/10 → Rechnung → Kette auf allen vier Seiten sichtbar; Textvorlage ändern → neues Angebot zeigt neuen Text.

---

### Task 6: Postgres-Test, Doku, Abschluss

- [ ] `scripts/test-postgres-migrations.sh`: Fall 6 legt vor dem Deploy ein Legacy-Quote mit `status='CONVERTED'` an (in der Phase-1-Legacy-Insert-Liste ergänzen) und prüft nach dem Deploy `ACCEPTED`; Tabellenzahl unverändert 26 (3a legt keine Tabelle an — prüfen!).
- [ ] Doku: LIMITATIONEN (EXPIRED nur abgeleitet; keine Online-Annahme bis 3b; Teillieferung nur mengenbasiert; Kette Tiefe 6), ARCHITEKTUR (Dokumentworkflow, Zustandsmaschinen, Kette), README (Workflow-Kurzanleitung).
- [ ] Prüfkette + Postgres-Skript; Commit `docs(docs): Dokumentworkflow dokumentiert, Postgres-Test erweitert`.

---

## Self-Review

- Spec-Abdeckung 3a: §2 Kette (T2/T5), §3 Status/Felder/Aktionen (T1/T2/T3/T5; Rabatt/Aufschlag Phase 4; Teil-/Abschlagsrechnung Phase 5), §5 AB (T3/T5), §6 Lieferschein inkl. Teillieferung/Flags/PDF/Status (T1/T3/T4/T5), §17 Dokumenttexte (T3/T5), §55 MCP (T5). §4 = Plan 3b.
- Plan-Ergänzung für Task 1 aus Task 3: Unique `TextTemplate(orgId, docType, position, name)` — im Task-1-Brief mitgeben.
- Typkonsistenz: `ConvertDocumentInput`/`UpdateDocumentInput` aus `src/schemas/index.ts`; `RefType` aus `relations.ts`; `ChainNode` in `chain.ts`.
