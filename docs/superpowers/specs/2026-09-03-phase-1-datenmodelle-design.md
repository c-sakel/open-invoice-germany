# Phase 1 — Datenmodell-Fundament

Stand: 2026-09-03 · Status: entworfen, per Arbeitsregel ohne Rückfrage freigegeben
Grundlage: Lastenheft Abschnitt 58 (Phase 1), Repository-Audit §3/§5, Phase 0 (Snapshots)

## Kontext

Das Lastenheft definiert Phase 1 als Datenmodell für DocumentRelation, DeliveryNote,
TextTemplate, EmailTemplate, EmailLog, CustomerAddress, ContactPerson, PaymentMethod,
DunningStage. Alle späteren Phasen (Mail, Dokumentketten, Lieferscheine, Zahlungsmethoden,
Mahnwesen) bauen darauf. Das Audit hat je Modell geprüft, was bereits existiert:

- Verknüpfungen bestehen heute als Spezialfelder: `Quote.convertedToInvoiceId`,
  `Invoice.correctsInvoiceId`, `Invoice.reversedByInvoiceId`, `Invoice.recurringInvoiceId`.
  `loadEInvoiceData` löst BG-3 über `correctsInvoiceId` auf — die Felder sind nicht entfernbar.
- `Quote` ist preisführend (`QuoteLine` mit Preisen/Steuern) und trägt drei kaufmännische
  Belegarten — kein Fundament für Lieferscheine.
- `NumberRange` existiert mit `pattern`/`seqPadding`; der Parser (`numbering.ts`) kennt
  `{PREFIX}{YYYY}{YY}{MM}{SEQ}`, nicht `{SEQ:n}` und `{DD}`. Die Zod-Enum `DocType`
  (`QUOTE|INVOICE|CREDIT_NOTE|DUNNING`) weicht von den real genutzten docTypes ab
  (`ANGEBOT|AUFTRAGSBESTAETIGUNG|PROFORMA|INVOICE|CREDIT_NOTE|DUNNING`).
- `Payment.method` ist ein String, validiert gegen die Zod-Enum `PaymentMethod`
  (`TRANSFER|CASH|CARD|SEPA`); `xrechnung.ts` mappt hart auf UNTDID 4461 Code `58`.
- Mahnstufen: `Dunning.level Int`, `level = dunnings.length`, Titel in `DUNNING_LEVEL_TITLE`
  (0–3). Keine Fristen, keine Konfiguration.
- `Customer` trägt genau eine Adresse und einen Freitext `contactName`.
- Seit Phase 0: Snapshot-Muster (`sellerSnapshotJson`, `buyerSnapshotJson`, `snapshotSource`,
  `snapshotAt`) auf Belegen; `SnapshotSource = FINALIZE|CREATE|INHERITED|MIGRATION`.

## Ziele

1. Alle neun Modelle additiv im Schema, für SQLite **und** Postgres migriert, mit Backfill,
   wo Bestandsdaten existieren.
2. Bestehende Verknüpfungen in `DocumentRelation` gespiegelt; neue Verknüpfungen werden ab
   sofort **doppelt** geschrieben (Altfeld + Relation), damit die Tabelle nie veraltet.
3. Nummernkreis-Parser um `{SEQ:n}` und `{DD}` erweitert, `DocType` an die Realität angepasst,
   `DELIVERY_NOTE` (Präfix `LS-`), `CUSTOMER`, `PRODUCT` als Kreise vorbereitet.
4. Zahlungsmethoden als Stammdaten mit Systemeinträgen; Bestandszahlungen bleiben auflösbar.
5. Mahnstufen als konfigurierbare Stammdaten mit Standardsatz; Bestandsmahnungen zugeordnet.
6. Reine Domainfunktionen und Services, die jedes Modell testbar machen — ohne UI.

## Nicht-Ziele (und warum)

- **Keine UI.** Das Lastenheft ordnet Oberflächen den Fachphasen 2–7 zu; die Definition of
  Done gilt je Funktion am Ende ihrer Phase. Phase 1 ist ausdrücklich Fundament.
- **Kein Umbau von `createDunning`, `recordPayment`, `xrechnung.ts`** (Phasen 4/6). Phase 1
  liefert die Daten, nicht die Logik.
- **Keine Ablösung der Altfelder** (`convertedToInvoiceId` usw.). Sie bleiben Quelle für
  BG-3 und werden parallel gepflegt.
- **Kein Dateispeicher** (Anhänge, Briefpapier) — Phase 4/7; EmailLog speichert nur Hashes.

## Entscheidungen

### DocumentRelation: generisch, ohne Fremdschlüssel, doppelt geschrieben

`fromType`/`fromId`/`toType`/`toId` als Strings — polymorph, Prisma kann keinen FK auf
mehrere Tabellen. Integrität sichert die Domain (Existenzprüfung beim Anlegen).
`relationType` ∈ `CONVERTED_TO | CORRECTS | REVERSES | GENERATED_BY | PARTIAL_OF |
DOWNPAYMENT_OF | FINAL_FOR | DELIVERED_BY` (Zod-Enum; die letzten vier reserviert für
Phase 3/5). Backfill-Migration spiegelt die vier Altfelder. `convert.ts`, `cancel.ts`,
`credit.ts`, `recurring/run.ts` schreiben ab sofort zusätzlich die Relation — in derselben
Transaktion, über eine Domainfunktion `linkDocuments(tx, …)`.

Verworfen: Altfelder entfernen. Destruktiv, bricht BG-3 (Lastenheft 53).

### DeliveryNote: eigenes, mengenführendes Modell mit Snapshot ab Tag eins

Eigenes Modell statt `Quote.kind = LIEFERSCHEIN`. Ein Lieferschein trägt keine Preise
(optional einblendbar), hat Liefer-/Versanddatum, Teil-Lieferungen je Quellposition. Er bekommt
das Phase-0-Snapshot-Muster von Anfang an (`snapshotSource = CREATE`), `internalNotes`,
Nummer aus `NumberRange` mit `docType = DELIVERY_NOTE`, Präfix `LS-`. Kein GoBD-Beleg,
also kein Guard in `db.ts`, aber `ChangeLog`-Einträge (`entity: DELIVERY_NOTE`), weil er den
Leistungszeitpunkt belegt (§ 14 Abs. 4 Nr. 6).

`DeliveryNoteLine.sourceType/sourceId` verweist optional auf `QuoteLine`/`InvoiceLine`
(Strings, wie DocumentRelation) — Grundlage für „gelieferte Menge je Quellposition" in Phase 3.
`articleNumber` ist nullable; `Product` bekommt in Phase 4 ein eigenes Feld.

### TextTemplate und EmailTemplate: Stammdaten, gerenderter Text wird zum Snapshot

Beide org-gebunden mit `docType`, `name`, `isDefault`. `TextTemplate.position` ∈
`HEAD | FOOT | TERMS_DELIVERY | TERMS_PAYMENT`; `EmailTemplate` mit `subject`, `body`,
`signature`. `isDefault` je (`orgId`, `docType`, `position`) hält die Domain eindeutig
(SQLite kennt keine portablen partiellen Unique-Indizes). Vorlagen sind keine Belege: Phase 2
schreibt den gerenderten Text in den Beleg (Snapshot-Prinzip), eine spätere Vorlagenänderung
berührt festgeschriebene Dokumente nie.

### EmailLog: Text vollständig, Anhänge als SHA-256 (Betreiberentscheidung)

`docType`/`docId` generisch. `toJson`/`ccJson`/`bccJson` (Adresslisten), `subject`,
`bodySnapshot`, `attachmentsJson` (`[{name, sha256, bytes}]`), `status` ∈
`QUEUED | SENT | DELIVERED | BOUNCED | FAILED`, `providerId`, `error`, `sentAt`. Ein
erfolgreicher Versand ist ein Belegereignis → **ein** ChangeLog-Eintrag (`action: SEND`) in
Phase 2; Provider-Statuswechsel bleiben im EmailLog (kein Hash-Chain-Rauschen, Audit K5).

### CustomerAddress: Zusatzadressen, Hauptadresse bleibt am Kunden

Die Hauptadresse bleibt in den bestehenden `Customer`-Feldern — sie wird heute von Mapper,
PDF, Snapshot und Tests gelesen. `CustomerAddress` hält **zusätzliche** Adressen (`type` ∈
`BILLING | SHIPPING | OTHER`, `label`, `isDefault` je Typ). Kein Backfill nötig, keine doppelte
Quelle. Phase 3 lässt Dokumente eine Zusatzadresse wählen; der Snapshot friert dann die
gewählte ein.

Verworfen: Hauptadresse in die Tabelle verschieben (`type = MAIN`) mit Backfill. Erzeugt zwei
Wahrheiten für dieselbe Adresse, bis alle Lesepfade umgestellt sind.

### ContactPerson: strukturierte Ansprechpartner, `contactName` bleibt Fallback

`firstName`, `lastName`, `role`, `phone`, `mobile`, `email`, `isDefault`. Kein Backfill aus
`Customer.contactName` (Freitext, nicht zuverlässig teilbar). Phase 3 ergänzt den
Buyer-Snapshot um `contact`; bis dahin bleibt `contactName` die Quelle.

### PaymentMethod: Stammdaten mit Systemeinträgen, Zod-Enum wird zur Laufzeitprüfung

`code` (eindeutig je Org), `name`, `description`, `paymentTermsDays`, `invoiceText`,
`bankAccountRef`, `untdidCode` (UNTDID 4461: Überweisung 58, Bar 10, EC/Debit 48,
Kreditkarte 54, PayPal 68, SEPA-Lastschrift 59, bereits bezahlt ZZZ, sonstige ZZZ),
`isSystem`, `isActive`, `sortOrder`. Migration legt die acht Systemeinträge **je bestehender
Organisation** an; `setup_company`/Org-Anlage legt sie für neue Organisationen an. Die vier
Altcodes `TRANSFER|CASH|CARD|SEPA` sind Systemcodes, Bestandszahlungen bleiben auflösbar.
Die Zod-Enum `PaymentMethod` wird zu `z.string().min(1)`; `recordPayment` prüft gegen aktive
Codes der Org (Zod bleibt an der Boundary, die Menge kommt aus der Tabelle).
`Customer.defaultPaymentMethodId` nullable. Das harte `58` in `xrechnung.ts` bleibt bis
Phase 4 (dort mit dem Rabatt-Mapping zusammen).

### DunningStage: konfigurierbare Stufen, Standardsatz per Migration, `level` bleibt

`order`, `name`, `daysAfterDue`, `newDueDays`, `feeCents`, `calculateInterest`,
`includeB2BFlatFee`, `emailTemplateId`, `documentTemplateId`, `enabled`;
`@@unique([orgId, order])`. Migration legt je Organisation vier Standardstufen an
(0 Zahlungserinnerung 3 Tage, 1 „1. Mahnung" 10 Tage, 2 „2. Mahnung" 10 Tage, 3 „3. Mahnung"
7 Tage; `newDueDays` 14; Zins und B2B-Pauschale ab Stufe 1 — Titel wie `DUNNING_LEVEL_TITLE`,
Fristen aus dem Lastenheft-Beispiel). `Dunning.stageId` nullable; Backfill ordnet
Bestandsmahnungen über `level → order` derselben Org zu. `Dunning.level` bleibt als
historischer Wert. `createDunning` wird erst in Phase 6 umgestellt.

### Nummernkreise: Parser erweitern, `DocType` an die Realität anpassen

`formatDocumentNumber` versteht zusätzlich `{DD}` und `{SEQ:n}` (n = Stellen; `{SEQ}` nutzt
weiterhin `seqPadding`). `DocType` wird `ANGEBOT | AUFTRAGSBESTAETIGUNG | PROFORMA | INVOICE |
CREDIT_NOTE | DUNNING | DELIVERY_NOTE | CUSTOMER | PRODUCT`; `QUOTE` entfällt aus der Enum,
der Präfix-Eintrag bleibt für Altdaten. `DOC_TYPE_DEFAULT_PREFIX` erhält `DELIVERY_NOTE: "LS-"`,
`CUSTOMER: "K-"`, `PRODUCT: "P-"`.

## Datenmodell (Prisma, beide Schemadateien identisch)

Alle Modelle: `id String @id @default(cuid())`, `orgId` + Relation + `@@index([orgId])`,
`createdAt`, `updatedAt`; Geld `…Cents Int`, Mengen `…Milli Int`, kein Json-Typ, keine Enums.
`Organization` bekommt je Modell eine Rückrelation. Details:

    DocumentRelation: fromType, fromId, toType, toId, relationType, createdAt
      @@index([fromType, fromId]) @@index([toType, toId]) @@unique([fromType, fromId, toType, toId, relationType])
    DeliveryNote: customerId, number?, status (DRAFT|CREATED|SENT|DELIVERED|INVOICED|CANCELLED),
      issueDate, deliveryDate?, shippingDate?, showPrices Bool false, showTax Bool false,
      notes?, internalNotes?, sellerSnapshotJson?, buyerSnapshotJson?, snapshotSource?, snapshotAt?
    DeliveryNoteLine: deliveryNoteId (Cascade), position, sourceType?, sourceId?, description,
      articleNumber?, quantityMilli, unit @default("C62")
    TextTemplate: name, docType, position, body, isDefault Bool false   @@index([orgId, docType])
    EmailTemplate: name, docType, subject, body, signature?, isDefault Bool false  @@index([orgId, docType])
    EmailLog: docType, docId, templateId?, toJson, ccJson, bccJson, subject, bodySnapshot,
      attachmentsJson @default("[]"), status, providerId?, error?, sentAt?   @@index([docType, docId])
    CustomerAddress: customerId (Cascade), type, label?, addressLine1, addressLine2?, postalCode,
      city, countryCode @default("DE"), isDefault Bool false   @@index([customerId])
    ContactPerson: customerId (Cascade), firstName, lastName, role?, phone?, mobile?, email?,
      isDefault Bool false   @@index([customerId])
    PaymentMethod: code, name, description?, paymentTermsDays?, invoiceText?, bankAccountRef?,
      untdidCode @default("ZZZ"), isSystem Bool false, isActive Bool true, sortOrder Int 0
      @@unique([orgId, code])
    DunningStage: order Int, name, daysAfterDue Int, newDueDays Int @default(14), feeCents Int 0,
      calculateInterest Bool, includeB2BFlatFee Bool, emailTemplateId?, documentTemplateId?,
      enabled Bool true   @@unique([orgId, order])
    Customer: + defaultPaymentMethodId?
    Dunning:  + stageId?

Zod (`src/schemas/index.ts`): Enums `RelationType`, `DeliveryNoteStatus`, `TextTemplatePosition`,
`EmailLogStatus`, `AddressType`; `DocType` angepasst; `PaymentMethod` → `z.string().min(1)`;
Eingabeschemas `createDeliveryNoteSchema`, `customerAddressSchema`, `contactPersonSchema`,
`paymentMethodSchema`, `dunningStageSchema`, `textTemplateSchema`, `emailTemplateSchema`.

## Migrationen (je Provider)

1. `phase1_foundation_models` — generierte DDL (additiv).
2. `phase1_backfill` — handgeschriebenes SQL:
   - `DocumentRelation` aus den vier Altfeldern (`INSERT … SELECT`, `WHERE NOT EXISTS`);
   - `PaymentMethod`: acht Systemeinträge je `Organization` (deterministische IDs
     `pm_<orgId>_<code>` — SQLite `||`, Postgres `||`);
   - `DunningStage`: vier Standardstufen je `Organization` (IDs `ds_<orgId>_<order>`);
   - `Dunning.stageId` per `level → order` über `Invoice.orgId`.
   Alles idempotent (`WHERE NOT EXISTS` / `IS NULL`), Zeitstempel im Provider-Format
   (SQLite `CAST(strftime('%s','now') AS INTEGER) * 1000`, Postgres `NOW()`).

## Domain

- `src/domain/relations.ts`: `linkDocuments(tx, { orgId, from, to, relationType })` (prüft
  Existenz beider Seiten über eine Typ→Tabelle-Zuordnung), `listRelations(docType, docId)`.
- `src/domain/delivery-note/create.ts`: `createDeliveryNote(orgId, input, opts)` — Nummer aus
  `NumberRange`, Snapshot `CREATE`, `ChangeLog` CREATE. Konvertierung aus Angebot/AB → Phase 3.
- `src/domain/masterdata/payment-methods.ts`: `ensureSystemPaymentMethods(tx, orgId)` —
  wird in der Org-Anlage (`setup_company`, `OrganizationForm`-Action) aufgerufen.
- `src/domain/masterdata/dunning-stages.ts`: `ensureDefaultDunningStages(tx, orgId)` — analog.
- `numbering.ts`: Parser-Erweiterung (rein).
- Dual-Write in `convert.ts`, `cancel.ts`, `credit.ts`, `recurring/run.ts` über `linkDocuments`.

## Tests

- Unit: `numbering.test.ts` erweitern (`{SEQ:5}`, `{DD}`, Rückwärtskompatibilität `{SEQ}`);
  `relations.test.ts` (Zod `RelationType`, Zuordnung Typ→Tabelle); `payment-methods.test.ts`
  (Systemcodes, UNTDID-Zuordnung).
- Integration (SQLite, Muster Phase 0): Backfill-Migration wortgleich ausführen → Relationen für
  eine konvertierte Quote, eine stornierte Rechnung, eine Abo-Rechnung; acht Zahlungsmethoden
  je Org; vier Mahnstufen; `Dunning.stageId` gesetzt. Dual-Write: nach `convertDocumentToInvoice`
  existiert die Relation `CONVERTED_TO`; nach `cancelInvoice` `REVERSES`. `createDeliveryNote`
  vergibt `LS-<Jahr>-0001` und schreibt Snapshot + ChangeLog. `recordPayment` mit unbekanntem
  Code → Fehler; mit Systemcode → ok.
- Postgres-Skript: Fall 6 — Legacy-Rows (konvertierte Quote, Zahlung, Mahnung) vor `deploy`,
  danach Relation, Zahlungsmethoden, Mahnstufen und `stageId` vorhanden.
- Bestehende Suite (68) bleibt grün; `mandatory`, `einvoice`, `gobd` unverändert.

## Migration auf der Produktivinstanz

Additiv. Backfill legt je Organisation Zahlungsmethoden und Mahnstufen an, spiegelt die
vorhandene Storno-Verknüpfung, ordnet Bestandsmahnungen zu. `./update.sh` reicht (Backup
inklusive). Prüfung danach: acht `PaymentMethod`, vier `DunningStage`, `DocumentRelation`
für den Storno.

## Risiken

- **Zwei Wahrheiten bei Verknüpfungen** (Altfeld + Relation). Gegenmittel: Dual-Write nur
  über `linkDocuments`, Integrationstests prüfen beides; Phase 3 stellt Leser um.
- **Org-Anlage ohne Systemdaten**, wenn ein Pfad `ensure*` vergisst. Gegenmittel: beide
  Org-Anlagepfade (MCP `setup_company`, UI-Action) rufen dieselbe Funktion; Test deckt es ab.
- **`PaymentMethod`-Enum-Entfernung** berührt `PaymentForm.tsx` (Auswahlliste). Phase 1 lädt
  die Liste aus der Tabelle — die eine UI-Berührung, die nötig ist, damit nichts bricht.
