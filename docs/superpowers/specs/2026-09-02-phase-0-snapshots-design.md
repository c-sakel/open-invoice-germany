# Phase 0 — Beleg-Snapshots und interne Notizen

Stand: 2026-09-02 · Status: entworfen, per Arbeitsregel ohne Rückfrage freigegeben
Grundlage: Repository-Audit (Konflikte 2 und 3, Phasenplan), Lastenheft 29/48/50/53

## Kontext

`src/lib/einvoice/mapper.ts` und `src/domain/document/pdf-data.ts` lesen Käufer- und
Verkäuferdaten zur Laufzeit aus den Relationen `invoice.customer` / `invoice.org`.
Eine Änderung an Kundenadresse oder Firmendaten verändert damit rückwirkend PDF und
XRechnung jeder bereits festgeschriebenen Rechnung. Der GoBD-Guard in `src/lib/db.ts`
schützt `Invoice`/`InvoiceLine`, nicht die Stammdaten — der Befund ist real und
betrifft die Produktivinstanz.

`Invoice.notes` ist kundensichtbar (PDF, BT-22 im XML) und trägt zugleich die
§ 14a-Pflichthinweise, die `validateMandatoryFields` (`src/domain/invoice/mandatory.ts`)
prüft. Das Lastenheft (48) verlangt Notizen, die nie nach außen gelangen.

`docs/ARCHITEKTUR.md` beschreibt in Teilen eine nie gebaute Fassung (Next 14,
Decimal, Dunning-Enum, EmailLog, Mustang-Sidecar). Nach Regel 61.6 gilt der Code.

Ein Einhängepunkt existiert bereits: **`finalizeWithinTx`** (`src/domain/invoice/finalize.ts`)
ist der einzige Pfad, über den Rechnungen festgeschrieben werden — `finalizeInvoice`,
`cancelInvoice`, `creditInvoice` und `runDueRecurring` rufen ihn. Er lädt `org` und
`customer` bereits per `include`. Angebote/AB/Proforma erhalten ihre Nummer in
`createBusinessDocument` (`src/domain/document/create.ts`) und sind heute nicht editierbar.

## Ziele

1. Festgeschriebene Rechnungen und nummerierte Geschäftsdokumente rendern dauerhaft mit
   den Käufer-/Verkäuferdaten zum Zeitpunkt der Festschreibung bzw. Erstellung.
2. Bestandsbelege werden per Migration eingefroren (Herkunft sichtbar markiert).
3. Interne Notizen als eigenes Feld, das PDF, XML und Mails nie erreicht.
4. `docs/ARCHITEKTUR.md` stimmt mit dem Code überein.
5. Die Ausgabe (PDF, XRechnung, ZUGFeRD) ändert sich für frisch erzeugte Belege **nicht**
   — Phase 0 ändert Herkunft der Daten, nicht ihren Inhalt.

## Nicht-Ziele

- Keine neuen Adress- oder Ansprechpartner-Modelle (Phase 1). Der Snapshot ist so
  geschnitten, dass Phase 1 ihn nur erweitert, nicht ersetzt.
- Keine Bearbeitung von Entwürfen (Phase 4). Entwürfe lesen weiterhin live.
- Keine UI-Umgestaltung über das Notizfeld hinaus.

## Entscheidungen

### Ein serialisierter JSON-String je Partei statt ~25 Einzelspalten

`sellerSnapshotJson` und `buyerSnapshotJson` (String, nullable) plus `snapshotSource`
(String, nullable: `FINALIZE` | `CREATE` | `MIGRATION`) und `snapshotAt` (DateTime,
nullable) auf `Invoice` und `Quote`. Das ist die Projektkonvention für strukturierte
Daten (`taxBreakdownJson`; kein Json-Typ, weil SQLite/Postgres-portabel), hält die
Migration auf vier Spalten, wird beim Lesen per Zod geparst und lässt Phase 1
(Adressen, Ansprechpartner) das Objekt erweitern statt Spalten nachzuziehen.

Verworfen: Einzelspalten (`buyerNameSnapshot`, …). Zwei Migrationen mit je ~25 Spalten,
und jede Erweiterung in Phase 1 wiederholt das.

### Snapshot-Inhalt = exakt die heutigen Mapper-Eingaben

Das Snapshot-Objekt entspricht **feldgenau** `MapInput.org` und `MapInput.customer`
aus `mapper.ts` (bzw. `DocInput` aus `pdf-data.ts`). Dadurch ist beweisbar, dass Phase 0
die Ausgabe nicht verändert: `buildEInvoiceData(mitSnapshot)` muss tief gleich
`buildEInvoiceData(live)` sein, solange die Stammdaten unverändert sind. Diese
Gleichheit ist Testfall, nicht Annahme.

### Zeitpunkt: Rechnung bei Festschreibung, Geschäftsdokument bei Erstellung

- **Invoice:** in `finalizeWithinTx`, innerhalb derselben Transaktion, im selben
  `tx.invoice.update`, das Status und Nummer setzt. Damit sind Storno, Teilgutschrift
  und Abo-Lauf automatisch abgedeckt. Entwürfe bekommen keinen Snapshot.
- **Quote:** in `createBusinessDocument`, weil dort die Nummer vergeben wird und
  Dokumente heute nicht editierbar sind. Phase 3 (Statusmaschine) kann bei `SENT`
  erneuern; das ist dort zu entscheiden, nicht hier.

### Lesen: Snapshot mit Fallback auf die Relation

`buildEInvoiceData` und `buildDocEInvoiceData` erhalten optionale Felder
`sellerSnapshotJson` / `buyerSnapshotJson`. Parsen per Zod; bei Erfolg wird der Snapshot
verwendet, sonst die Relation. Entwürfe haben keinen Snapshot und landen so natürlich im
Live-Pfad. Ein defekter Snapshot bricht die Ausgabe nicht, sondern fällt zurück — und
wird geloggt (`console.warn` mit Beleg-ID), damit er nicht stumm bleibt.

### Backfill als SQL in beiden Migrationen, Herkunft `MIGRATION`

Betreiberentscheidung: Bestandsbelege werden aus dem heutigen Stamm eingefroren. Der
Backfill läuft als SQL innerhalb der Migration (SQLite: `json_object(...)`, Postgres:
`json_build_object(...)`), weil `migrate deploy` auf der Produktivinstanz automatisch
beim Containerstart läuft und ein separater Skriptschritt ein Stolperstein wäre.
Betroffen: `Invoice` mit `status <> 'DRAFT'`, `Quote` mit `number IS NOT NULL`.
Die Migration ist additiv — keine Spalte wird entfernt oder umgedeutet.

Verworfen: Backfill per Node-Skript. Müsste auf jeder Instanz manuell laufen; Lastenheft
53 verlangt, dass Bestandsinstallationen aktualisierbar bleiben.

### `internalNotes` als neues Feld, `notes` bleibt unangetastet

`internalNotes String?` auf `Invoice` und `Quote`. Es wird in keiner Mapper-Eingabe
geführt und kann EInvoiceData strukturell nicht erreichen. UI: Feld „Interne Notiz" mit
sichtbarem Zusatz „nur intern sichtbar" in `NewInvoiceForm` und `NewDocumentForm`,
Anzeige auf den Detailseiten mit derselben Kennzeichnung. `notes` behält Bedeutung,
Validierung und Tests.

### ARCHITEKTUR.md wird an den Code angeglichen, nicht neu geschrieben

Abschnitte 1 (Datenmodell), 2 (E-Rechnung) und 4 (Ordnerstruktur) werden auf den
Ist-Stand gebracht; Abschnitt 5 (Stufen) wird als Roadmap gekennzeichnet und verweist
auf das Lastenheft. Abschnitt 3 (Lizenz) bleibt.

## Datenmodell

Auf `Invoice` **und** `Quote`, jeweils:

    sellerSnapshotJson String?
    buyerSnapshotJson  String?
    snapshotSource     String?   // FINALIZE | CREATE | MIGRATION
    snapshotAt         DateTime?
    internalNotes      String?

Zod (`src/schemas/index.ts`):

    SnapshotSource = z.enum(["FINALIZE", "CREATE", "MIGRATION"])
    sellerSnapshotSchema = z.object({ legalName, addressLine1, addressLine2, postalCode,
      city, country, vatId, taxNumber, email, phone, electronicAddress, iban, bic, bankName })
    buyerSnapshotSchema  = z.object({ name, contactName, addressLine1, addressLine2,
      postalCode, city, countryCode, vatId, email, leitwegId })

Nullable-Felder als `z.string().nullable()`. Die Feldlisten sind mit `MapInput` in
`mapper.ts` identisch zu halten — ein Unit-Test prüft die Schlüsselmengen gegeneinander.

Beide Schemadateien (`prisma/schema.prisma`, `prisma/schema.postgres.prisma`) identisch
pflegen (CI `schema-drift`). Migrationsname in beiden Verzeichnissen:
`phase0_snapshots_internal_notes`.

## Ablauf

**Festschreiben** (`finalizeWithinTx`): nach der Pflichtangabenprüfung und vor
`appendChangeLog` werden aus dem bereits geladenen `invoice.org` / `invoice.customer`
die Snapshot-Objekte gebaut (reine Funktion `buildSellerSnapshot(org)` /
`buildBuyerSnapshot(customer)` in `src/domain/snapshot.ts`), serialisiert und im
bestehenden `tx.invoice.update` mitgeschrieben (`snapshotSource: "FINALIZE"`,
`snapshotAt: now`). Der ChangeLog-Diff enthält die Snapshot-Felder — der Hash deckt
sie damit ab.

**Dokument anlegen** (`createBusinessDocument`): analog mit `snapshotSource: "CREATE"`.

**Lesen** (`loadEInvoiceData`, Dokument-PDF-Route): unverändert laden; Mapper wählt.

**Backfill** (Migration): ein `UPDATE … SET sellerSnapshotJson = json_…(…),
buyerSnapshotJson = …, snapshotSource = 'MIGRATION', snapshotAt = <jetzt>` je Tabelle,
per Join auf Organization/Customer, nur wo `snapshotSource IS NULL`.

## Tests

- **Unit** `test/unit/snapshot.test.ts`: (a) Zod-Schemas akzeptieren die Ausgabe von
  `buildSellerSnapshot`/`buildBuyerSnapshot`; (b) Schlüsselmengen der Zod-Schemas sind
  identisch mit den Schlüsseln, die `buildEInvoiceData` aus `org`/`customer` liest;
  (c) Mapper bevorzugt den Snapshot; (d) ungültiger Snapshot → Fallback auf Relation;
  (e) `internalNotes` taucht in `EInvoiceData` nicht auf (strukturell: Schlüssel fehlt).
- **Integration** `test/integration/snapshot.test.ts` (SQLite, wie `gobd.test.ts`):
  (a) Rechnung anlegen → festschreiben → Kunde und Organisation ändern →
  `loadEInvoiceData` liefert unverändert die alten Werte; (b) Entwurf spiegelt die
  Änderung; (c) Quote bekommt Snapshot bei Erstellung; (d) Storno-Gutschrift trägt
  eigenen Snapshot; (e) **Backfill**: Snapshot-Spalten einer festgeschriebenen Rechnung
  per `$executeRaw` auf NULL setzen, das SQLite-Backfill-Statement (aus einer gemeinsam
  genutzten Datei `prisma/backfill/phase0-sqlite.sql`) ausführen, Herkunft `MIGRATION`
  und identischen Inhalt zum Live-Stand prüfen; (f) Ausgabegleichheit: für eine frisch
  festgeschriebene Rechnung ist `buildEInvoiceData` mit Snapshot tief gleich der
  Live-Variante.
- **Postgres** `scripts/test-postgres-migrations.sh`, neuer Fall 4: Baseline anwenden,
  eine Organisation/Kunde/festgeschriebene Rechnung per SQL einfügen (Legacy-Zustand
  ohne Snapshot), `migrate deploy` → Phase-0-Migration läuft → Snapshot befüllt,
  `snapshotSource = 'MIGRATION'`, JSON per `jsonb`-Cast gültig.
- Bestehende Suite bleibt grün; `mandatory.test.ts` unverändert.

## Migration auf der Produktivinstanz

Additiv. Beim nächsten Deployment wendet der Entrypoint die Migration an; der Backfill
friert die vorhandenen Belege ein. Vorher ein Backup (macht `update.sh` ohnehin).
Es ist die **erste** Folgemigration nach der Baseline — sie beweist den Migrationspfad.

## Risiken

- **SQL-JSON weicht vom Zod-Schema ab** (Schlüsselname, NULL-Behandlung): fällt zur
  Laufzeit stumm auf den Live-Pfad zurück und wäre damit unsichtbar. Gegenmittel: die
  Integrationstests (e) und der Postgres-Fall 4 parsen das Backfill-JSON mit demselben
  Zod-Schema. Der Fallback loggt zusätzlich eine Warnung.
- **Zwei Dialekte**: SQLite `json_object`, Postgres `json_build_object`. Beide Tests
  müssen laufen; CI führt beide aus.
- **Größe**: zwei kurze JSON-Strings je Beleg — vernachlässigbar.
