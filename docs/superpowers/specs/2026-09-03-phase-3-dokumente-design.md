# Phase 3 — Dokumentverkettung, Angebot, Auftragsbestätigung, Lieferschein

**Lastenheft:** §2 Einheitliches Dokumentsystem, §3 Angebotsverwaltung, §4 Online-Angebotsannahme, §5 Auftragsbestätigungen, §6 Lieferscheine; dazu §17 Typ „Dokumenttext" (aus Phase 2 verschoben) und §32 „Letztes Dokument übernehmen" nur soweit „duplizieren" es abdeckt. Rabatt/Aufschlag/Skonto (§10/§11) bleiben Phase 4, Teil-/Abschlags-/Schlussrechnung (§13–15) Phase 5.

**Baut auf:** Phase 1 (`DocumentRelation` + `linkDocuments`/`listRelations`, `DeliveryNote`/`DeliveryNoteLine` mit `sourceType`/`sourceId`, `TextTemplate`, `ContactPerson`, `CustomerAddress`, Nummernkreis `DELIVERY_NOTE`), Phase 2 (Mailversand, `EmailDocType` DELIVERY_NOTE bereits vorgesehen, Provider für Benachrichtigungen).

## 1. Ist-Stand

- `Quote` (kind ANGEBOT | AUFTRAGSBESTAETIGUNG | PROFORMA) mit `status` DRAFT | CONVERTED, `validUntil`, `notes`, `internalNotes`, Summen, `convertedToInvoiceId`; keine Kopf-/Fußtexte, kein Betreff, keine Liefer-/Zahlungsbedingungen, keine Kundenreferenz, kein Ansprechpartner.
- `convertDocumentToInvoice(documentId)` — einzige Konvertierung (Quote → Rechnung, Relation CONVERTED_TO). Kein Angebot → AB, kein → Lieferschein.
- `createDeliveryNote` (Domain, ohne Route/Action/UI/PDF); `DeliveryNoteLine.sourceType/sourceId` vorhanden, aber nirgends befüllt.
- Detailseite `dokumente/[id]`: PDF-Link, Konvertieren-Button, Link zur Rechnung. Keine Kette, keine Statusaktionen, kein Duplizieren.
- Keine öffentliche Route außer Login/Setup/Auth/Cron; kein Rate-Limiting.
- `TextTemplate` (Phase 1) ohne UI und ohne Verwendung.

## 2. Entscheidungen

| Frage | Entscheidung | Warum |
|---|---|---|
| Umfang | **Zwei Pläne**: 3a Kette + Angebot/AB + Lieferschein + Dokumenttexte; 3b Online-Annahme. Eine Spec. | 3b hat eigene Sicherheitsfläche (öffentlich), verdient ein eigenes Review. |
| Angebotsstatus | `status`: DRAFT, SENT, ACCEPTED, REJECTED, EXPIRED, CANCELLED. **Abrechnungsstand wird abgeleitet**, nicht gespeichert: `billingState` = NONE / PARTIAL / FULL aus den Relationen CONVERTED_TO (+ Phase 5: PARTIAL_INVOICE). Legacy `CONVERTED` → Migration auf `ACCEPTED` (die Relation trägt den Abrechnungsstand). | Lastenheft nennt „teilberechnet/vollständig berechnet" — das ist ein Faktum aus der Kette, kein Lebenszyklus; zwei Zustandsräume vermischen wäre fehleranfällig. |
| AB-Status | DRAFT, SENT, CANCELLED; Abrechnungsstand abgeleitet wie oben. | §5. |
| Lieferscheinstatus | DRAFT, CREATED, SENT, DELIVERED, INVOICED (abgeleitet aus Relation zur Rechnung), CANCELLED. `CREATED` = Nummer vergeben. | §6. |
| SENT setzen | Automatisch bei erfolgreichem Mailversand (Phase-2-Hook) **und** manuell „als versendet markieren". | Postversand existiert. |
| EXPIRED | Abgeleitet zur Anzeige (`validUntil < heute` und Status SENT/DRAFT); Scheduler (Phase 6) darf es später persistieren. | Kein Cron in Phase 3. |
| Neue Quote-Felder | `subject`, `headerText`, `footerText`, `deliveryTerms`, `paymentTerms`, `customerReference`, `contactPersonId?`, `billingAddressId?`, `sentAt?`, `decidedAt?`, `decisionNote?`, `archivedAt?`. Alle nullable/mit Default. Snapshot bleibt Phase-0-Muster; Ansprechpartner und Adresse werden beim SENT/ACCEPT **in den Buyer-Snapshot** aufgenommen (Felder `contactName`, Adresse). | §3 Felder; Snapshot-Regel §29. |
| Kopf-/Fußtext-Quelle | Beim Anlegen aus `TextTemplate` (docType + position HEAD/FOOT, `isDefault`) vorbelegt; am Beleg gespeichert und editierbar. Platzhalter der Phase-2-Engine erlaubt, gerendert beim PDF. | §17. |
| Konvertierungen | Generische `convertDocument(fromType, fromId, toType, opts)` in `src/domain/document/convert.ts` (bestehende Quote→Invoice bleibt als Sonderfall darin): Angebot → AB, Angebot/AB → Rechnung, Angebot/AB/Rechnung → Lieferschein (mit Mengenvorgabe je Position), AB → Rechnung. Jede Konvertierung: Positionen kopieren, Kopf-/Fußtext des Zieltyps aus Vorlage, `linkDocuments(CONVERTED_TO)` in derselben Tx, ChangeLog. | §2 „generisch statt Spezialfelder". |
| Teillieferung | `DeliveryNoteLine.sourceType/sourceId` = Quelle je Position; `remainingQuantity(sourceType, sourceId)` = Quellmenge − Σ gelieferte Mengen (nicht-stornierte Lieferscheine). UI zeigt Restmengen; Lieferschein-Anlage schlägt Rest vor. „Vollständig geliefert" = alle Restmengen 0 → Anzeige am Quellbeleg. | §6 Beispiel 10 = 4 + 6. |
| Lieferschein-PDF | `renderDeliveryNotePdf` in `src/lib/pdf/delivery-note-pdf.ts`, Layout wie Rechnung, Flags `showPrices`, `showTax`, `showArticleNumber`, `showDescription`, Liefer-/Versanddatum. Preise nur, wenn Quelle Preise hat. | §6. |
| Dokumentkette | `DocumentChain` (Server-Komponente) auf **allen** Detailseiten (Angebot, AB, Lieferschein, Rechnung): Baum über `listRelations`, Tiefe ≤ 6, Zahlungen als Blatt unter der Rechnung, aktueller Beleg hervorgehoben. Domain `buildDocumentChain(orgId, type, id)`. | §2 „in jedem Dokument sichtbar". |
| Duplizieren | `duplicateDocument(type, id)` → neuer Entwurf ohne Nummer, Datum heute, Texte übernommen, Relation `DUPLICATED_FROM` (neuer Relationstyp). Für Angebot/AB/Lieferschein; Rechnung dupliziert als Rechnungs-Entwurf. | §3, §47 teilweise. |
| Archivieren | `archivedAt`; Listen blenden archivierte per Filter aus. Kein Löschen. | §3; GoBD-nah. |
| Online-Annahme (3b) | Modell `QuoteShareLink { id, quoteId, tokenHash (sha256), expiresAt, revokedAt?, createdAt, acceptedByName?, acceptedByEmail?, comment?, decidedAt?, ip? }`. Token 32 Byte base64url, nur der Hash gespeichert. Route `/angebot/[token]` öffentlich (PUBLIC_PREFIXES), zeigt HTML-Ansicht + PDF + Annehmen/Ablehnen (Name Pflicht, E-Mail optional, Kommentar). Rate-Limit: In-Memory-Token-Bucket je IP und je Token (10/min), dokumentiert als Single-Instance-Grenze. Annahme → `status ACCEPTED`, ChangeLog `QUOTE/ACCEPTED_ONLINE`, Benachrichtigungs-Mail an `org.email` über Phase-2-Provider (als EmailLog docType ANGEBOT sichtbar). IP nur speichern, wenn `DocumentSettings.storeAcceptIp`. Link widerrufbar, Ablauf = `validUntil` bzw. `DocumentSettings.shareLinkDays`. | §4 vollständig; Sicherheit: kein Enumerieren möglich, Hash statt Token in DB. |
| Automatik nach Annahme | `DocumentSettings` 1:1 Org: `onQuoteAccept` NONE / ORDER_CONFIRMATION / INVOICE, `shareLinkDays` (Default 30), `storeAcceptIp` (Default false). UI unter Einstellungen → Dokumente. | §4 „optionale Einstellung". |
| Nummernkreise | AB und Lieferschein haben eigene (`AB-`, `LS-`) — vorhanden. UI-Pflege bleibt Phase 7. | §5. |
| E-Mail | Lieferschein-Versand freischalten (Anhang-Builder DELIVERY_NOTE → PDF); AB/Angebot senden setzt SENT. | §3/§5/§6. |
| Abgrenzung | Kein Rabatt/Aufschlag (Phase 4), keine Abschlags-/Teil-/Schlussrechnung (Phase 5), kein Scheduler (Phase 6), keine Nummernkreis-UI (Phase 7), keine Timeline (Phase 8). Lager/WaWi nie (§60). | §58/§60. |

## 3. Datenmodell (beide Dialekte, Migration `phase3_documents`)

- `Quote`: + `subject String?`, `headerText String?`, `footerText String?`, `deliveryTerms String?`, `paymentTerms String?`, `customerReference String?`, `contactPersonId String?`, `billingAddressId String?`, `sentAt DateTime?`, `decidedAt DateTime?`, `decisionNote String?`, `archivedAt DateTime?`. Backfill: `status = 'CONVERTED'` → `'ACCEPTED'`.
- `DeliveryNote`: + `headerText String?`, `footerText String?`, `showArticleNumber Boolean @default(true)`, `showDescription Boolean @default(true)`, `sentAt DateTime?`, `deliveredAt DateTime?`, `archivedAt DateTime?`. Status-Default bleibt DRAFT.
- `DeliveryNoteLine`: + `unitNetPriceCents Int?`, `taxRate Int?` (nur für `showPrices`), `sourceLineId String?` (präzise Quellposition; `sourceType/sourceId` bleiben für den Beleg).
- `Invoice`: + `headerText String?`, `footerText String?` (Kopf-/Fußtext auch auf Rechnungen — §7 verlangt es später; hier nur Felder + PDF-Ausgabe, keine Editor-Erweiterung).
- Neu `QuoteShareLink` (3b) wie oben; Index `tokenHash` unique.
- Neu `DocumentSettings` (3b) 1:1 Org.
- `DocumentRelation.relationType`: Zod `RelationType` kennt bereits CONVERTED_TO, CORRECTS, REVERSES, GENERATED_BY, PARTIAL_OF, DOWNPAYMENT_OF, FINAL_FOR, DELIVERED_BY; neu `DUPLICATED_FROM`. Lieferschein aus Quelle: Relation `DELIVERED_BY` (Quelle → Lieferschein), nicht CONVERTED_TO.
- `TextTemplate.position` Werte existieren bereits als Zod `TextTemplatePosition` = HEAD, FOOT, TERMS_DELIVERY, TERMS_PAYMENT — unverändert nutzen.

## 4. Module

```
src/domain/document/status.ts          Zustandsmaschine Quote/DeliveryNote (erlaubte Übergänge, markSent/markAccepted/markRejected/cancel/archive)
src/domain/document/convert.ts         convertDocument(orgId, from, to, opts) — generisch, Quote→Invoice bleibt Sonderfall
src/domain/document/duplicate.ts       duplicateDocument(orgId, type, id, actor)
src/domain/document/chain.ts           buildDocumentChain(orgId, type, id) → Baum + billingState
src/domain/document/billing-state.ts   billingStateFor(orgId, type, id) aus Relationen
src/domain/delivery-note/{create,quantities,status}.ts   remainingQuantities(sourceType, sourceId), Teillieferung
src/domain/text-template/{ensure,pick}.ts                Standard-Dokumenttexte je docType/position, pickTextTemplate
src/lib/pdf/delivery-note-pdf.ts       renderDeliveryNotePdf
src/lib/pdf/invoice-pdf.ts             Kopf-/Fußtext rendern (Platzhalter-Engine)
src/domain/quote-share/{token,link,accept}.ts  (3b) createShareLink, revoke, resolveToken, acceptOffer, rejectOffer
src/lib/rate-limit.ts                  (3b) In-Memory-Token-Bucket
src/app/angebot/[token]/page.tsx + route.ts (PDF) + actions   (3b) öffentlich
src/app/einstellungen/dokumente/page.tsx   (3b) DocumentSettings; src/app/einstellungen/textvorlagen  Dokumenttexte-CRUD (3a)
src/components/DocumentChain.tsx, DocumentStatusActions.tsx, DeliveryNoteForm.tsx, ConvertMenu.tsx
Seiten: dokumente/[id] (Angebot/AB erweitert), lieferscheine/, lieferscheine/[id], lieferscheine/neu, rechnungen/[id] (Kette + Lieferschein erzeugen)
MCP (§55): convert_document, create_delivery_note, set_document_status — gleiche Zod-Schemas
```

## 5. Tests (Kernfälle §54)

- Zustandsmaschine: erlaubte/verbotene Übergänge (DRAFT→ACCEPTED verboten ohne SENT? **Erlaubt**: Annahme kann telefonisch nach Postversand kommen — Ruling), CANCELLED terminal.
- Konvertierung: Angebot→AB kopiert Positionen/Texte, Relation CONVERTED_TO, ChangeLog; AB→Lieferschein mit Teilmengen 4+6 → Restmenge 0 → „vollständig geliefert"; Überlieferung (7 bei Rest 6) → Fehler; storniert zählt nicht.
- Kette: Angebot→AB→LS→Rechnung→Zahlung als Baum; Tiefe begrenzt; fremde Org unsichtbar.
- Duplizieren: neuer Entwurf ohne Nummer, Relation DUPLICATED_FROM.
- PDF: Lieferschein mit/ohne Preise (Textinhalt prüfen), Kopf-/Fußtext mit Platzhaltern gerendert.
- 3b: Token nicht erratbar (nur Hash in DB), abgelaufen/widerrufen → 404, Annahme setzt ACCEPTED + ChangeLog + Mail an Org, Rate-Limit greift (11. Aufruf → 429), Automatik erzeugt AB bzw. Rechnung (Relation), IP nur mit Einstellung.
- Postgres-Skript: Tabellenzahl 28; Backfill CONVERTED→ACCEPTED in Fall 6 prüfen.

## 6. Nicht in Phase 3

Rabatt/Aufschlag/Skonto, Abschlags-/Teil-/Schlussrechnung, Scheduler-persistiertes EXPIRED, Nummernkreis-UI, Timeline/Dashboard, Mehrsprachigkeit der öffentlichen Seite (nur Deutsch), verteiltes Rate-Limiting (Redis).
