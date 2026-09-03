# SDD ledger — plan: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-02-phase-0-snapshots.md

Spec: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-02-phase-0-snapshots-design.md (gelesen).
Voraussetzung: Merge von fix/postgres-migrations in main NACH Fix-Welle + Re-Review.
Branch: phase-0/snapshots aus main.

## Pre-Flight-Scan

| Paare | erzeugt -> konsumiert | Befund |
|---|---|---|
| T1 -> T2 | buildSellerSnapshot/buildBuyerSnapshot/parse* + Zod-Schemas -> finalize.ts, create.ts, mapper.ts, pdf-data.ts | ok, Namen identisch |
| T1 -> T2 | Migration *_phase0_backfill_snapshots -> Integrationstest liest die Datei per Glob | ok, Suffix identisch |
| T1 <-> T3 | src/schemas/index.ts: T1 ergaenzt Snapshot-Schemas, T3 ergaenzt internalNotes in createInvoiceSchema/createDocumentSchema | ok, disjunkte Stellen |
| T2 <-> T3 | document/create.ts: T2 setzt Snapshot-Felder, T3 setzt internalNotes im selben tx.quote.create | **Reihenfolge**: Plan erlaubt beides; T2 laesst internalNotes weg, T3 ergaenzt |
| T1 -> T4 | Migrationen -> Postgres-Testskript Fall 3/4 | ok |
| T4 <-> Fix-Welle | scripts/test-postgres-migrations.sh wird VOR Phase 0 durch die Fix-Welle umgebaut (db-prepare.sh, run_with_timeout, Fall 4 Happy-Path) | **Konflikt**: Plan-Task-4 referenziert alte Zeilen; Brief muss beim Dispatch um den neuen Stand ergaenzt werden; Fall-Nummern verschieben sich (Backfill wird Fall 5) |
| T2 -> T5 | Ausgabegleichheit -> Doku-Aussage in LIMITATIONEN | ok |

| Task | Selbstkonsistenz |
|---|---|
| T1 | ok — 10 ADD COLUMN (5 je Tabelle), Backfill-JSON-Schluessel = Zod-Schluessel (Test 2 prueft) |
| T2 | ok — Integrationstest nutzt createInvoice/finalizeInvoice/cancelInvoice/createBusinessDocument; Signaturen im Brief nicht garantiert -> Implementer muss gegen gobd.test.ts abgleichen (Plan sagt das) |
| T3 | ok — @ts-expect-error als Typ-Waechter |
| T4 | siehe Konflikt oben |
| T5 | ok |

Ruling: Task 4 wird beim Dispatch mit dem tatsaechlichen Stand des Testskripts nach der
  Fix-Welle versorgt (db-prepare.sh statt docker-entrypoint.sh, vorhandene Faelle 1-4, Backfill
  als Fall 5) — Grund: das Skript aendert sich zwischen Planerstellung und Ausfuehrung —
  Kosten falls falsch: eine Fix-Runde in Task 4.
Ruling: Reihenfolge T2 vor T3 wie geplant; T2 laesst internalNotes in create.ts bewusst aus.
Task 4: Nachtrag geschrieben (task-4-addendum.md) — Ist-Zustand des Testskripts nach
  Fix-Welle 5fe5db1; Backfill-Test wird Fall 5; Fall 4 (Happy-Path) bleibt.

## Ausfuehrung
Branch phase-0/snapshots aus main erstellt. BASE = HEAD von main nach Merge.
Task 1: dispatched (sonnet), BASE a0c00fd
Merkzettel fuer den naechsten idle-Zustand des Arbeitsbaums (Branchwechsel auf specs):
  - Backlog: I5 aus dem Migrations-Review (nicht-fatales migrate diff --exit-code nach deploy
    als Drift-Warnung) als Folgepunkt eintragen; I4 (harte Tabellenzahlen) wird durch
    Phase 0 Task 4 erledigt.
  - Plan phase-0: Task-4-Nachtrag (db-prepare.sh, Fall 5) in die Plan-Datei uebernehmen.
Task 1: implementer DONE (commit f8c971e), 60/60 Tests, 4 Migrationsverzeichnisse.
Task 1: Bedenken — SQLite-DDL nutzt Prismas RedefineTables fuer Invoice (Tabelle neu
  aufgebaut, Daten per INSERT...SELECT kopiert) statt 5x ADD COLUMN. Controller-Pruefung
  siehe Ausgabe oben; an den Reviewer weitergereicht.
Task 1: Ruling: RedefineTables in der SQLite-DDL wird akzeptiert — Grund: Prismas Standardweg
  fuer SQLite, INSERT...SELECT kopiert alle 31 Bestandsspalten (30 Baseline + recurringInvoiceId),
  Snapshot-Spalten bleiben NULL bis zum Backfill; kein Datenverlust, Postgres-DDL hat 10x
  ADD COLUMN — Kosten falls falsch: der SQLite-Solo-Pfad, nicht die Produktivinstanz.
Task 1: task reviewer dispatched (sonnet), diff a0c00fd..f8c971e; Pruefschwerpunkt
  dreifache Schluesselgleichheit Zod <-> MapInput <-> Backfill-SQL.
Task 1: review clean — Spec ✅, freigegeben. RedefineTables vom Reviewer eigenstaendig als
  unkritisch bestaetigt (31 Bestandsspalten kopiert, Indizes/FKs neu angelegt).
Task 1: minor (deferred): kein PRAGMA foreign_key_check im generierten SQLite-SQL — Prisma-Output.
Task 1: minor -> in Task 2 gefaltet: Schluesselmengen-Test ist tautologisch (Fixture statt
  MapInput). Ruling: Task 2 exportiert den Typ MapInput aus mapper.ts und der Unit-Test bekommt
  Compile-Time-Zuweisungen `const _s: MapInput["org"] = buildSellerSnapshot(org)` (analog buyer),
  damit eine Mapper-Aenderung den Typecheck bricht — Kosten falls falsch: keine.
Task 1: complete (commits a0c00fd..f8c971e, review clean)
Task 2: dispatched (sonnet), BASE f8c971e
Task 2: implementer DONE (commit 22b9270), 66/66, 6 neue Integrationsfaelle gruen.
Task 2: Bedenken — (a) Invoice.number global @unique, Test pinnt Jahr 2027 gegen Kollision mit
  gobd.test.ts (Test-Isolation, kein Produktivcode); (b) Brief-SQL-Split war falsch (Kopfkommentar
  enthaelt ';'), zeilenbasiertes Kommentar-Strippen stattdessen — Plan-Defekt, sinnvoll geloest;
  (c) internalNotes in document/create.ts wie angeordnet ausgelassen.
Backlog-Merker: Invoice.number ist global statt je orgId eindeutig — relevant erst bei Multi-Tenant.
Task 2: task reviewer dispatched (sonnet), diff f8c971e..22b9270
Task 2: review clean — Spec ✅, freigegeben. Mapper vollstaendig umgestellt (inkl. buyerReference,
  Bankdaten), Snapshot im updateMany-Claim, Gutschrift mit eigenem Snapshot (Codepfad verifiziert).
Task 2: minor (deferred): src/app/api/documents/[id]/pdf/route.ts laedt Quote ohne orgId-Scope —
  vorbestehend, Single-Tenant; Backlog-Merker fuer den Multi-Tenant-Fall.
Task 2: minor (deferred): Fallback-Warnung (console.warn) in Produktionspfaden ungetestet; Unit-Test
  deckt parse*-Fallback ab.
Task 2: complete (commits f8c971e..22b9270, review clean)
Task 3: dispatched (sonnet), BASE 22b9270
Task 3: implementer DONE (commit 83297ce), 67/67, E2E per tsx-Skript gegen dev.db belegt
  (Service heisst createDraftInvoice, nicht createInvoice — Implementer hat angeglichen).
Task 3: task reviewer dispatched (sonnet), diff 22b9270..83297ce
Task 3: review clean — Spec ✅, freigegeben. Leckpruefung ueber MCP (get/list_invoices,
  list_documents), alle API-Routen, PDF/XML/ZUGFeRD: kein Pfad gibt das rohe Prisma-Objekt aus.
  @ts-expect-error-Waechter als strukturell wirksam bestaetigt (Excess-Property-Check).
Task 3: minor (deferred): E2E per Ad-hoc-tsx-Skript statt API-Route — zulaessig, Skript entfernt.
Task 3: complete (commits 22b9270..83297ce, review clean)
Task 4: dispatched (sonnet), BASE 83297ce, mit task-4-addendum.md
Task 4: implementer durch Spend-Limit (HTTP 429) abgebrochen — nach Edit, vor Testlauf/Commit.
  Arbeitsbaum: scripts/test-postgres-migrations.sh modifiziert (+31/-4), kein Bericht, kein
  Container. Edit sieht vollstaendig aus (Legacy-Setup per db execute + INSERTs, Fall 3 mit
  zweitem deploy, Fall 5 Backfill mit jsonb_object_keys als Table-Function).
Task 4: re-dispatched (sonnet) mit Auftrag "zu Ende fuehren, nicht neu beginnen".
Task 4: implementer DONE (commit 409812a), Faelle 1-5 gruen, 67/67. Einzige Korrektur am
  Vorgaenger-Diff: docker exec -i (Heredoc wurde sonst nicht an psql durchgereicht — stiller
  No-op mit Exit 0, von Fall 5 entlarvt). Plan-Defekt: der Brief-Block hatte kein -i.
Task 4: task reviewer dispatched (sonnet), diff 83297ce..409812a
Task 4: review clean — Spec ✅ (Brief+Nachtrag), freigegeben. Legacy-INSERTs decken alle
  NOT-NULL-Spalten, Fall 5 nicht-trivial, Schluesselzahlen 14/10 nachgezaehlt, -i einzige Stelle.
Task 4: minor (deferred): Legacy-INSERTs laufen vor migrate resolve — funktional egal.
Task 4: complete (commits 83297ce..409812a, review clean)
Task 5: dispatched (sonnet), BASE 409812a
Task 5: implementer DONE (commit b4b4ad4). Pruefkette 6/6 gruen (typecheck, lint, 67/67, build,
  validate:erechnung, postgres 1-5). 13 Korrekturen in ARCHITEKTUR.md, zwei begruendete
  Abweichungen vom Brief zugunsten des Codes (Dunning-Titel "3. Mahnung"; Streichung einer
  widerspruechlichen Altzeile).
Task 5: task reviewer dispatched (sonnet), diff 409812a..b4b4ad4
Task 5: review — Spec ✅, 1 Important (Hinweisblock "entfernt" vs. unmarkierte Mustang-
  Bewertungstabelle in Abschnitt 2), 2 Minor (Ordnerbaum ohne src/components, src/proxy.ts,
  docker-compose.yml; Lesbarkeit Abschnitt 2).
Task 5: Ruling: Fix-Runde 1 fuer den Important; die Ordnerbaum-Auslassungen werden mitgezogen
  (gleiche Datei, drei Zeilen) — Kosten falls falsch: keine. Lesbarkeit bleibt geparkt.
Task 5: fix round 1 implementiert (commit fd631c2): Tabelle als historische Abwaegung markiert,
  Hinweisblock wahr formuliert, Ordnerbaum um components/, proxy.ts, docker-compose.yml ergaenzt.
Backlog-Merker: docker-compose.yml (Upstream) referenziert auskommentiert einvoice-service/, das
  nicht existiert — Code-Altlast, Folgepunkt.
Task 5: scoped re-review dispatched (sonnet), diff b4b4ad4..fd631c2
Task 5: fix round 1/5 (2 addressed, 0 open; commits b4b4ad4..fd631c2)
Task 5: minor (deferred): Formulierung "(12 Dateien), inkl. forms/" minimal unscharf (12 direkt + 4).
Task 5: complete (commits 409812a..fd631c2, review clean nach Runde 1)
ALLE TASKS ABGESCHLOSSEN. Branch: 6 Commits, alle DCO-signiert, Pruefkette 6/6 gruen.
FINAL whole-branch review dispatched (opus), diff a0c00fd..fd631c2
FINAL REVIEW (opus): Merge ja mit Auflagen. Schluesselkette komplett schluessig, Hash-Chain
  unberuehrt, kein Renderpfad umgeht den Mapper ausser Mahnungs-PDF.
  I-1 SQLite-Backfill schreibt snapshotAt als TEXT (CURRENT_TIMESTAMP), Prisma erwartet
      INTEGER ms -> falsche Sortierung/Vergleiche (empirisch belegt in test.db).
  I-2 README-Baseline-Prozedur: Diff gegen Head-Datamodel zeigt Phase-0-Spalten; manuell
      eingespielt -> migrate deploy scheitert mit "already exists".
  I-3 Storno/Teilgutschrift snapshotten heutige Stammdaten statt die des Originals.
  I-4 dunnings/[id]/pdf liest live (baut seller/buyer selbst) — braucht Schemaaenderung.
  M-1..M-9 (SnapshotSource-Enum ungenutzt, Gleichheitstest ohne Aussagekraft, internalNotes
  geht bei convert verloren, kein Edit-Pfad, kein Herkunfts-Badge, stiller Fallback,
  README-Mustang-Satz, ASCII-Fixture, localeCompare in canonicalize).
Ruling: EINE Fix-Welle mit I-1, I-2, I-3, M-1, M-2, M-3, M-5, M-7, M-8 und dem Doku-Satz zu
  I-4 — Grund: alle klein, dieselben Dateien, und die Migration ist noch nicht ausgeliefert
  (Checksumme aenderbar) — Kosten falls falsch: eine Re-Review-Runde.
Ruling I-3: Storno/Teilgutschrift ERBEN die Snapshots des Originals mit snapshotSource
  "INHERITED" (neuer Enum-Wert) — Grund: der Korrekturbeleg berichtigt genau das Original;
  abweichende Empfaengerdaten zwischen beiden waeren ein Pruefungsbefund — Kosten falls falsch:
  eine Gutschrift traegt die Adresse des Originalbelegs statt die heutige; das ist verteidigbar.
Ruling I-4: Mahnungs-Snapshot braucht ein Schema (Dunning) -> Phase 1 Backlog; jetzt nur der
  ehrliche Satz in LIMITATIONEN. M-4 (Edit-Pfad) -> Phase 4. M-6 (stiller Fallback: ChangeLog/
  UI-Signal) und M-9 (localeCompare) -> Backlog.
Ruling I-2: README-Regel wird praezisiert: Referenz fuer "Baseline-Stand" ist 0_init/migration.sql;
  Anweisungen, die Tabellen/Spalten aus SPAETEREN Migrationen unter prisma/migrations-postgres/
  betreffen, werden NICHT von Hand eingespielt — das erledigt migrate deploy nach dem resolve.
FINAL fix wave dispatched (sonnet)
FINAL fix wave DONE (commit 554a47a): I-1..I-4 (I-4 nur Doku), M-1/2/3/5/7/8. 68/68, Postgres 1-5
  mit Umlaut-Fixture, typeof(snapshotAt)=integer fuer FINALIZE/INHERITED/MIGRATION.
Ruling: dev.db-Reset vom Implementer korrekt verweigert (Prisma-KI-Sperre); vom Controller
  per Datei loeschen + migrate deploy + seed neu aufgesetzt — Grund: Wegwerf-Demodaten,
  gitignored — Kosten falls falsch: keine.
FINAL scoped re-review dispatched (sonnet), diff fd631c2..554a47a
FINAL re-review: alle Befunde ADDRESSED, Merge-Empfehlung: mergen.
Parked: M-8 prueft Umlaute nur ueber Schluesselzahl, nicht inhaltlich — Ruling: traegt;
  optional nachschaerfbar — Kosten falls falsch: keine (Postgres json_build_object ist UTF-8-sicher).
PLAN COMPLETE: phase-0/snapshots -> main (ff).
