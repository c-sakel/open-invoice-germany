# Nachtrag zu Task 4 — tatsaechlicher Stand von scripts/test-postgres-migrations.sh

Das Skript wurde NACH Planerstellung durch die Fix-Welle des Migrations-Branches
umgebaut (Commit 5fe5db1). Der Brief referenziert Zeilen/Inhalte, die so nicht mehr
existieren. Dieser Nachtrag ersetzt die betroffenen Brief-Schritte.

## Ist-Zustand (verbindlich)

- Es gibt `scripts/db-prepare.sh` (Sonde + `migrate deploy`, Exit 0 bei Erfolg).
  `scripts/docker-entrypoint.sh` ruft es nur noch auf. **Im Test wird ueberall
  `db-prepare.sh` aufgerufen, nie mehr `docker-entrypoint.sh`.**
- `run_with_timeout SEK BEFEHL...` existiert; jeder `db-prepare.sh`-Aufruf laeuft damit.
- Fall 1: `run_with_timeout 120 ./scripts/db-prepare.sh`, dann Tabellenzahl 15.
- Block "Datenbank leeren und Bestandslage herstellen": Zeile ~48 nutzt weiterhin
  `npx prisma db push --schema prisma/schema.postgres.prisma --skip-generate --accept-data-loss`.
  **Das ist die Falle aus dem Brief (Schritt 1) und wird wie dort beschrieben durch
  `prisma db execute --file prisma/migrations-postgres/0_init/migration.sql` plus die
  Legacy-INSERTs ersetzt.**
- Fall 2: `if OUT=$(run_with_timeout 120 ./scripts/db-prepare.sh 2>&1); then fail ...`,
  Grep auf "migrate resolve", Tabellenzahl 14. Bleibt inhaltlich; Aufruf nicht aendern.
- Fall 3 (Zeile ~62-66): `migrate resolve --applied 0_init`, dann
  `migrate deploy ... | grep -q "No pending migrations"`. **Nach Phase 0 falsch** —
  wie im Brief Schritt 2: erster deploy muss durchlaufen (Folgemigrationen), zweiter
  deploy meldet "No pending migrations".
- Fall 4 (Zeile ~68-73, NEU durch die Fix-Welle): `db-prepare.sh` nach Baseline,
  Exit 0, Grep auf "No pending migrations". **Nach Phase 0 stimmt der Grep nur, wenn
  Fall 3 die Folgemigrationen bereits angewendet hat** — das tut der angepasste Fall 3.
  Fall 4 bleibt damit unveraendert gueltig. Nicht anfassen.
- Der Backfill-Test aus Brief Schritt 3 wird **Fall 5** (nicht 4), vor
  `echo "ALLE TESTS BESTANDEN"`.

## Reihenfolge der Aenderungen

1. Bestandslage per Baseline-SQL + Legacy-INSERTs (Brief Schritt 1).
2. Fall 3 wie Brief Schritt 2.
3. Fall 5 = Brief Schritt 3, Ueberschrift "Fall 5: Backfill friert Legacy-Belege ein".
4. Gesamtlauf: Faelle 1-5 gruen.

Fall 1 erwartet weiterhin 15 Tabellen, Fall 2 weiterhin 14 (Phase 0 fuegt nur Spalten hinzu).
