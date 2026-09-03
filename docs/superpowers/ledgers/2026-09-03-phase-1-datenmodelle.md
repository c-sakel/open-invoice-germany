# SDD ledger — plan: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-03-phase-1-datenmodelle.md

Spec: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-03-phase-1-datenmodelle-design.md (gelesen).
Branch: phase-1/foundation aus main 9da0f14. Arbeitsregel: Empfehlungen umsetzen, nicht fragen.

## Pre-Flight-Scan

| Paare | erzeugt -> konsumiert | Befund |
|---|---|---|
| T1 -> T2 | @@unique([fromType,fromId,toType,toId,relationType]) -> upsert-Key fromType_fromId_toType_toId_relationType | ok, Prisma-Namenskonvention |
| T1 -> T4 | @@unique([orgId,code]) / @@unique([orgId,order]) -> orgId_code / orgId_order | ok |
| T1 -> T3 | DELIVERY_NOTE-Praefix "LS-", Pattern-Default {PREFIX}{YYYY}-{SEQ}, padding 4 -> Test erwartet LS-2028-0001 | ok |
| T1 -> T2/T4 | Zod DocType-Aenderung: keine Nutzung ausserhalb src/schemas (grep) | ok |
| T2 <-> T4 | beide erweitern test/integration/phase1.test.ts | ok, disjunkte it-Bloecke, gleiche setup() |
| T4 -> gobd.test.ts | recordPayment prueft Zahlungsmethode; Alt-Tests legen Orgs ohne Systemdaten an | im Plan geloest: Selbstheilung via ensureOrgMasterdata bei fehlendem Treffer |
| T1 -> T5 | 10 neue Tabellen -> Fall 1 = 25, Fall 2 = 24 | **Plan korrigiert** (stand 24/23) |
| T5 Legacy-INSERTs | Quote/Payment/Dunning NOT-NULL-Spalten | Implementer prueft gegen 0_init (Plan sagt das) |

| Task | Selbstkonsistenz |
|---|---|
| T1 | ok — Backfill-SQL beider Dialekte vollstaendig ausformuliert; Booleans SQLite 0/1, Postgres TRUE/FALSE |
| T2 | ok — cancel.ts-Variablen heissen original/credit (verifiziert) |
| T3 | ok |
| T4 | ok — PaymentForm hat kein Select (verifiziert), keine UI-Aenderung |
| T5 | ok nach Korrektur |

Ruling: Tabellenzahl im Plan von 24/23 auf 25/24 korrigiert (zehn neue Tabellen inkl.
  DeliveryNoteLine) — Kosten falls falsch: Fall 1/2 schlagen mit klarer Meldung fehl.

## Ausfuehrung
Task 1: dispatched (sonnet), BASE 9da0f14
Merker T3: Brief ist kurz (Service in Prosa "nach Muster document/create.ts") — beim Dispatch
  den konkreten Code mitgeben, um Placeholder-Risiko zu vermeiden.
Task 1: implementer DONE (commit 9e5a10a), 74/74. Vier Migrationen. Backfill in SQLite (dev.db)
  und Postgres (Wegwerf) belegt: 8 PaymentMethod, 4 DunningStage je Org.
Task 1: Bedenken — SQLite baut Customer und Dunning per RedefineTables neu (FK-Spalten);
  CREATE TABLE = 12 statt 10. Controller-Zaehlung der kopierten Spalten siehe oben.
Task 1: task reviewer dispatched (sonnet), diff 9da0f14..9e5a10a
Task 1: review clean — Spec ✅, freigegeben. Backfill beider Dialekte vollstaendig gelesen,
  REVERSES-Richtung korrekt, TS-Konstanten textgleich zum SQL.
Task 1: minor (deferred): Dunning-Backfill setzt stageId NULL statt Fehler bei verwaister
  invoiceId — FK schliesst das aus.
Task 1: complete (commits 9da0f14..9e5a10a, review clean)
Task 2: dispatched (sonnet), BASE 9e5a10a
Task 3: Nachtrag mit konkretem Service-Code geschrieben (task-3-addendum.md), weil der Brief nur
  Prosa enthielt — Ruling: Placeholder-Risiko vermeiden — Kosten falls falsch: keine.
Task 2: implementer DONE (commit 82d38bf), 78/78. Dual-Write in convert/cancel/credit/recurring.
Task 2: Bedenken — (1) finalizedCredit.id statt credit.id in cancel.ts (identischer Wert);
  (2) Test-Snippets des Briefs um Pflichtfelder ergaenzt; (3) Commit traegt Co-Authored-By/
  Claude-Session-Trailer entgegen Dispatch (Harness-Vorgabe). Ruling: auf Fork-Branches
  akzeptiert; beim Herausloesen von Upstream-PRs werden Trailer entfernt — Kosten falls falsch:
  ein Rebase vor dem PR.
Task 2: task reviewer dispatched (sonnet), diff 9e5a10a..82d38bf
Task 2: review clean — Spec ✅, freigegeben. Alle linkDocuments im tx, vor appendChangeLog;
  Richtung deckungsgleich mit Backfill; Idempotenztest echt.
Task 2: minor (deferred): listRelations ohne orgId-Filter — Single-Tenant ok, Multi-Tenant-Merker.
Task 2: complete (commits 9e5a10a..82d38bf, review clean)
Task 3: dispatched (sonnet), BASE 82d38bf, mit task-3-addendum.md
Task 3: implementer DONE (commit 0516c4d), 79 Tests, LS-2028-0001/0002 belegt. Bedenken:
  Zod-Output-Typ verlangt Default-Felder im Test (showPrices/showTax explizit) — Projektkonvention.
Task 3: task reviewer dispatched (sonnet), diff 82d38bf..0516c4d
Task 3: review clean — Spec ✅, freigegeben, keine Befunde.
Task 3: complete (commits 82d38bf..0516c4d, review clean)
Task 4: dispatched (sonnet), BASE 0516c4d
Task 4: implementer DONE (commit e0b9820), 81 Tests, beide Org-Anlage-Pfade.
Task 4: Plan-Defekt gefunden — Migrations-Block 4 ordnet stageId per konstruierter ID
  ds_<org>_<order> zu; ensure.ts mit cuid-IDs haette den Backfill (FK) brechen lassen.
  Implementer hat ensure.ts auf dasselbe deterministische ID-Schema gebracht.
  Ruling: akzeptiert; die Kopplung an den Reviewer weitergegeben (Alternative: Block 4 per
  Lookup (orgId, order) statt ID-Konstruktion — Migration ist noch nicht ausgeliefert).
Task 4: task reviewer dispatched (sonnet), diff 0516c4d..e0b9820
Task 4: review — Spec ✅, freigegeben mit Auflage (Mittel = Important): Migrations-Block 4
  konstruiert stageId statt Lookup; stille Invariante zwischen zwei Schreibern.
Task 4: Ruling: Fix-Runde 1 — Block 4 in BEIDEN Backfill-Migrationen auf Lookup (orgId, order)
  umstellen; ensure.ts zurueck auf Prisma-Default-IDs (Kopplung damit vollstaendig weg);
  saveOrganization ruft ensureOrgMasterdata in beiden Zweigen (Symmetrie zu setup_company) —
  Grund: Migration noch nicht ausgeliefert, Aenderung jetzt kostenlos, spaeter riskant —
  Kosten falls falsch: eine Re-Review-Runde.
Task 4: minor (deferred): keine Selbstheilung fuer Mahnstufen bei Bestands-Orgs ohne Backfill
  (kein Leser in Phase 1) — mit der Symmetrie-Zeile entschaerft.
Task 4: fix round 1 dispatched (resume) — Block 4 Lookup in beiden Dialekten, ensure.ts ohne
  explizite IDs, saveOrganization symmetrisch.
Merker T5: Brief-Fall 6 prueft `stageId = ds_org1_1` (haelt, weil Block 3 die Stufe fuer org1
  selbst anlegt), robuster: stageId = (select id from DunningStage where orgId='org1' and
  "order"=1). Beim Dispatch so vorgeben.
Task 4: fix round 1 implementiert (commit 79ccd5f): Lookup in beiden Dialekten, ensure.ts ohne
  IDs, saveOrganization beide Zweige. Postgres-Nachweis mit fremdem ID-Format bestanden.
  dev.db vom Controller neu aufgesetzt (Datei loeschen + deploy + seed).
Task 4: scoped re-review dispatched (sonnet), diff e0b9820..79ccd5f
Task 4: Controller-Fund beim dev.db-Reset: frische DB + Seed -> 0 PaymentMethod, 0 DunningStage.
  Ursache: prisma/seed.ts legt die Organisation direkt an (dritter Org-Anlagepfad), die
  Backfill-Migration lief auf leerer DB. Ruling: in Task 5 als eigener Schritt/Commit —
  seed.ts ruft ensureOrgMasterdata nach dem Anlegen; Test: nach Seed 8/4 — Kosten falls falsch:
  keine; die Selbstheilung in recordPayment deckt Zahlungen ohnehin ab.
Task 4: fix round 1/5 (1 addressed, 0 open; commits e0b9820..79ccd5f)
Task 4: complete (commits 0516c4d..79ccd5f, review clean nach Runde 1)
Task 5: dispatched (sonnet), BASE 79ccd5f — mit Seed-Fix (ensureOrgMasterdata in prisma/seed.ts),
  Fall-6-Assertion per Lookup, Tabellenzahlen 25/24
Task 5: implementer DONE (commits 1422f92, 4c497e5, 0d0213b). Postgres 1-6 gruen, Seed 8|4,
  Pruefkette 6/6.
Task 5: Ruling: Fall 2 bleibt bei 14 Tabellen — mein Plan (24) war falsch, Fall 2 basiert auf
  0_init und sieht Phase 1 nie; Implementer hat es real belegt — Kosten falls falsch: keine.
Task 5: task reviewer dispatched (sonnet), diff 79ccd5f..0d0213b
Task 5: reviewer APPROVED (spec OK, quality OK, 1 Low informativ: Fall-6-Lookup vs. konstruierte ID — kein Handlungsbedarf)
Task 5: complete
Final: whole-branch review dispatched (opus), package review-9da0f14..0d0213b.diff, 8 commits, 30 Dateien
Final: review (opus) — Kritisch 0; Wichtig W1 listRelations/assertDocExists ohne orgId, W2 createDunning
  schreibt stageId nicht; Gering G1 LIMITATIONEN:26 falsche Phase, G2 MCP record_payment altes Enum,
  G3 {DD} faellt still auf 1, G4 documentTemplateId ohne Ziel, G5 SQLite-Test ohne Mahnung, G6 Selbst-
  heilung bei jedem Fehlversuch, G7 gemischte ID-Formate. Adjudikation: (1) Fix jetzt, (2) gegenstandslos
  (FK NOT NULL+CASCADE; realer Fall level>3 = W2), (3) Backlog, (4) sauber.
Final: Ruling: EINE Fix-Welle mit W1, W2, G1, G2 (Lastenheft 55: gleiche Validierung an MCP), G3
  (Einzeiler) — G4-G7 Backlog. Kosten falls falsch: eine Re-Review-Runde.
Final: fix dispatched (sonnet), BASE 0d0213b
Final: fix DONE (4e363ed, 208607c, 36f096c), 83/83; scoped re-review dispatched (sonnet), diff 0d0213b..36f096c
Final: re-review APPROVED (5/5 behoben, keine Kollateralschaeden). Merge phase-1/foundation -> main (ff).
