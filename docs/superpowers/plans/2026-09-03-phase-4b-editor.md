# Phase 4b — Rechnungseditor, Positionsblöcke, Rich-Text, Dateianhänge: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Rechnungs-/Dokumenteditor bekommt vollständige Kopfdaten, echte Positionsblöcke (Überschrift, Textblock, Zwischensumme), sicher formatierte Positionstexte, Drag&Drop, Duplizieren, Produktauswahl mit Inline-Anlage sowie Dateianhänge je Beleg, die beim Mailversand wählbar sind — konsistent in PDF und E-Rechnung.

**Architecture:** Rich-Text als eingeschränktes Markdown mit eigenem Parser/Sanitizer (`src/lib/richtext/`), gerendert zu HTML (escaped) und pdfkit-Runs; Positionstypen als `lineType` an `InvoiceLine`/`QuoteLine`; Anhänge als `DocumentAttachment` mit dedupliziertem Dateispeicher (`ATTACHMENTS_DIR`) und Magic-Byte-Prüfung; Editor als eine erweiterte `NewInvoiceForm`/`NewDocumentForm` (bestehende Komponenten, kein Parallelbau); Entwurfsbearbeitung für Rechnungen (`updateDraftInvoice`) analog zu `updateDraftDocument` (3a).

**Tech Stack:** Next.js 16, TypeScript strict, Prisma 6.19.3, Zod 4, vitest, pdfkit, node:fs/crypto. Keine neuen npm-Abhängigkeiten.

**Spec:** `docs/superpowers/specs/2026-09-03-phase-4-rechnungskomfort-design.md` (Abschnitte 4b). Baut auf Plan 4a auf (Rabattfelder, Pricing-Modul); Branch aus `main` nach dem 4a-Merge.

## Global Constraints

- Kein ungefiltertes HTML speichern oder rendern (§9): Speicherformat Markdown-Teilmenge, Ausgabe nur über den eigenen Renderer mit Escaping; Links nur `https://`/`mailto:`.
- HEADING/TEXT/SUBTOTAL-Positionen tragen keine Beträge, gehen nie in Summen, XML oder Steuerberechnung (§8 „kein Menge-0-Workaround").
- Anhänge: ≤ 10 MB je Datei, ≤ 50 MB je Beleg, Whitelist + Magic-Bytes, keine ausführbaren Dateien, Ablage außerhalb des Web-Roots, Zugriff nur org-geprüft (§38). Kein GoBD-Beleg → löschbar, mit ChangeLog.
- GoBD: festgeschriebene Rechnungen unveränderbar; Editor nur für DRAFT; Snapshot-Regel (Kunde/Ansprechpartner/Adresse wie 3a).
- Zod überall; keine Prisma-Enums; beide Schemas byte-gleich; Migrationen additiv. Testjahr **2035**.
- Prüfkette: `npm run typecheck && npm run lint && npm test && npm run build && npm run validate:erechnung`.

---

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| Prisma + Migration `phase4b_editor` | `InvoiceLine`/`QuoteLine`: `lineType String @default("ITEM")`, `descriptionLong String?`, `articleNumber String?`; `Product.articleNumber String?` (+ Unique je Org optional → nur Index); `Invoice`: `subject`, `orderNumber`, `internalReference`, `contactPersonId`, `billingAddressId`, `shippingAddressId` (+ Relationen SetNull); `DocumentAttachment` |
| `src/schemas/index.ts` | `LineType`, `invoiceLineInputSchema` + `lineType/descriptionLong/articleNumber` (Beträge bei HEADING/TEXT/SUBTOTAL auf 0 erzwungen), `createInvoiceSchema` + Kopffelder, `updateInvoiceSchema`, `attachmentUploadSchema` |
| `src/lib/richtext/{parse,render-html,render-pdf,sanitize}.ts` | `parseRichText(md) → Block[]`, `renderRichTextHtml(blocks)`, `renderRichTextPdf(doc, blocks, opts)`, `plainText(blocks)` |
| `src/lib/attachments/{storage,mime}.ts` | `storeFile(buffer, mime, filename)`, `readFile(storagePath)`, `deleteFileIfUnreferenced`, `sniffMime(buffer)` |
| `src/domain/invoice/update.ts` | `updateDraftInvoice(orgId, id, rawInput, actor)` (nur DRAFT; Positionen ersetzen; Pricing) |
| `src/domain/document/lines.ts` | `normalizeLines(lines)` (Positionsnummern, Typen, Beträge 0 bei Nicht-ITEM), `computeSubtotals(lines)` (für PDF/UI) |
| `src/domain/attachment/{manage,list}.ts` | `addAttachment(orgId, docType, docId, file, actor)`, `removeAttachment`, `listAttachments`, `loadAttachmentForSend` |
| `src/domain/email/attachments.ts`, `compose.ts`, `send.ts` | Beleg-Anhänge als wählbare Zusatzanhänge (`attachmentIds`) |
| `src/lib/pdf/invoice-pdf.ts`, `delivery-note-pdf.ts`, `src/lib/einvoice/{mapper,xrechnung,cii}.ts` | Blöcke/Zwischensummen/Rich-Text im PDF; XML nur ITEMs, `descriptionLong` als BT-154 Klartext, Artikelnummer BT-155 |
| Routen/Actions | `PATCH /api/invoices/[id]`, `POST/GET /api/attachments` (multipart), `GET /api/attachments/[id]` (Download), `DELETE`, `POST /api/products` inline (bestehend?) |
| UI | `NewInvoiceForm`/`NewDocumentForm` (Kopfdaten-Sektion, Positionsliste mit Typen, Drag&Drop, Duplizieren, Produkt-Picker + Inline-Dialog, Rich-Text-Feld mit Toolbar + Vorschau), `rechnungen/[id]/bearbeiten`, `AttachmentPanel`, `SendEmailDialog` (Beleganhänge) |
| Tests | `test/unit/richtext.test.ts`, `test/unit/lines.test.ts`, `test/unit/attachments-mime.test.ts`, `test/integration/invoice-update.test.ts`, `test/integration/attachments.test.ts`, Erweiterung `email.test.ts` |
| Doku | LIMITATIONEN, ARCHITEKTUR, README, `.env.example` (`ATTACHMENTS_DIR`), Server-Compose (Volume) |

---

### Task 1: Schema, Migration, Zod, Positions-Normalisierung
- Felder wie oben; `DocumentAttachment { id, orgId, docType, docId, filename, mime, sizeBytes, sha256, storagePath, uploadedBy, createdAt }`, Index `[orgId, docType, docId]`, Unique `[orgId, sha256, docType, docId]` (gleiche Datei zweimal am selben Beleg verhindern).
- Zod: `LineType = z.enum(["ITEM","HEADING","TEXT","SUBTOTAL"])`; Superrefine: Nicht-ITEM → `quantityMilli`, `unitNetPriceCents`, Rabatte = 0, `taxRate` 0; `descriptionLong` max 5000; `articleNumber` max 60.
- `normalizeLines`: Positionen fortlaufend, Nicht-ITEM-Beträge 0, `computeSubtotals` liefert je SUBTOTAL die Summe der ITEM-Netto seit letzter HEADING/SUBTOTAL.
- Tests: Zod-Refine, Normalisierung, Zwischensummen (Beispiel Lastenheft: Einrichtung/Hosting).
- Commit `feat(editor): Schema und Zod fuer Positionsbloecke, Kopfdaten und Anhaenge`.

### Task 2: Rich-Text (pure, TDD)
- Parser: Absätze, Zeilenumbruch, `**fett**`, `_kursiv_`, `__unterstrichen__`, `- ` / `1. ` Listen (eine Ebene), `[Text](https://…)`; alles andere Klartext (kein HTML, `<`/`>` werden escaped). Sanitizer verwirft Links mit anderen Schemata. `renderRichTextHtml` erzeugt nur `<p><strong><em><u><ul><ol><li><a rel="noopener" target="_blank"><br>`. `renderRichTextPdf` schreibt Runs mit `continued: true` und Fontwechsel (Helvetica/-Bold/-Oblique; unterstrichen via `underline: true`), Listen mit Einrückung und Bullet/Nummer. `plainText` für XML.
- Tests: Escaping (`<script>` bleibt Text), verbotene Links, verschachtelte Formatierung, Listen, PDF-Renderer erzeugt `%PDF` und wirft nicht bei 200 Zeilen.
- Commit `feat(richtext): eingeschraenktes Markdown mit HTML- und PDF-Renderer`.

### Task 3: Anhänge und Entwurfsbearbeitung (Domain)
- Storage: `ATTACHMENTS_DIR` (Default `./data/attachments`), Pfad `<orgId>/<sha256[0:2]>/<sha256>`; `sniffMime` prüft Magic-Bytes (PDF `%PDF`, PNG, JPG, ZIP-Container für DOCX/XLSX mit Prüfung auf `[Content_Types].xml`), Textformate (XML/CSV/TXT) auf UTF-8/kein NUL; Whitelist; Größenlimits; Dedup per Hash; Löschen entfernt Datei nur, wenn keine andere Zeile denselben `storagePath` referenziert.
- `addAttachment`/`removeAttachment` mit Org-Prüfung des Belegs (Quote/Invoice/DeliveryNote) und ChangeLog `ATTACHMENT`/`ADD|REMOVE` (Hash, Name, Größe).
- `updateDraftInvoice`: nur DRAFT, Kopffelder + Positionen (Typen) + Rabatte (4a) + Skonto + Zahlungsmethode; Snapshot-Regel wie `updateDraftDocument`; ChangeLog UPDATE.
- Mail: `prefillEmail` liefert `documentAttachments[{id, filename, size}]`; `sendDocumentEmail` akzeptiert `attachmentIds` (org-geprüft, gleicher Beleg) und lädt sie aus dem Speicher; Log hält Hash/Name.
- Tests: Limits, Magic-Bytes (PDF mit .exe-Endung → abgelehnt; EXE-Bytes mit .pdf → abgelehnt), Dedup, Fremd-Org, Löschen mit/ohne Referenz, Versand mit Beleganhang, `updateDraftInvoice` verweigert bei FINALIZED.
- Commits `feat(attachments): Dateispeicher, Domain und Mailversand` und `feat(editor): Rechnungsentwurf bearbeiten`.

### Task 4: PDF und E-Rechnung
- PDF: HEADING als fette Zeile ohne Beträge, TEXT als Rich-Text-Absatz über die Breite, SUBTOTAL als rechtsbündige Zwischensumme; ITEM mit Artikelnummer-Spalte (wenn irgendeine Position eine hat) und `descriptionLong` als Rich-Text unter der Bezeichnung.
- XML: nur ITEM-Zeilen; `descriptionLong` → BT-154 (`cbc:Description` UBL / `ram:Description` CII) als Klartext; `articleNumber` → BT-155 (`cac:SellersItemIdentification/cbc:ID` / `ram:SellerAssignedID`); Kopffelder: `orderNumber` → BT-13 (`cac:OrderReference/cbc:ID`), `subject` nicht ins XML.
- Fixtures für `validate:erechnung`: Rechnung mit Blöcken + Artikelnummer + Langtext; Regression der Bestandsfixtures.
- Commit `feat(editor): Positionsbloecke und Rich-Text im PDF, BT-13/154/155 im XML`.

### Task 5: Routen, UI, MCP
- Editor: Kopfdaten-Sektion (Betreff, Bestellnummer, interne Referenz, Ansprechpartner, Rechnungs-/Lieferadresse, Leistungszeitraum, Leitweg-ID-Override); Positionsliste: Typ-Auswahl je Zeile, Drag&Drop (native HTML5), „Duplizieren", „Produkt wählen" (Suche über `/api/products?q=`), „Neues Produkt" (`<dialog>` mit `ProductForm`, Action legt an und fügt ein), Rich-Text-Feld mit Toolbar (fett/kursiv/unterstrichen/Liste/Link → fügt Markdown ein) und Live-Vorschau (Client-Renderer aus Task 2, pure); Zwischensummen live.
- `rechnungen/[id]/bearbeiten` (nur DRAFT) mit `initial`; `dokumente` analog erweitern.
- `AttachmentPanel` auf Rechnung/Dokument/Lieferschein: Upload (multipart, Fortschritt), Liste, Download, Löschen (Dialog). `SendEmailDialog`: Beleganhänge als Checkboxen.
- Routen: `PATCH /api/invoices/[id]`, `POST /api/attachments` (multipart, `content-length`-Vorprüfung wie Mail), `GET /api/attachments/[id]` (org-geprüft, `Content-Disposition: attachment`, `no-store`), `DELETE /api/attachments/[id]`.
- MCP: `update_invoice_draft`, `add_attachment` (base64, gleiche Limits), `list_attachments`, `remove_attachment`.
- Commits `feat(editor): Routen, Actions und MCP fuer Editor und Anhaenge`, `feat(editor): Kopfdaten, Positionsbloecke, Rich-Text, Drag-and-Drop und Anhaenge im UI`. Manuelle Prüfung: Rechnung mit Überschrift/Zwischensumme/Langtext anlegen, Produkt inline anlegen, PDF prüfen, Anhang hochladen und per Mail mitschicken.

### Task 6: Postgres-Test, Doku, Betrieb
- Tabellenzahl 29; `ATTACHMENTS_DIR` in `.env.example`, Docker-Compose-Volume-Hinweis in README/BETRIEB (Server: `/opt/open-invoice-germany/data/attachments`, Backup-Skript einschließen).
- LIMITATIONEN (Rich-Text-Teilmenge, keine Bilder, eine Listenebene, Anhänge nicht in ZUGFeRD eingebettet), ARCHITEKTUR, README.
- Commit `docs(editor): Editor, Positionsbloecke, Rich-Text und Anhaenge dokumentiert`.

## Self-Review
§7 (Kopfdaten T1/T5, Positionen inkl. Artikelnummer/Langtext/Rabatt T1/T4/T5, Drag&Drop/Duplizieren/Produkt T5), §8 (T1/T4/T5), §9 (T2/T4/T5), §38 (T1/T3/T5/T6). Typen: `Block[]` aus `richtext/parse.ts`; `LineType` aus Schemas; `DocumentAttachment` Prisma.
