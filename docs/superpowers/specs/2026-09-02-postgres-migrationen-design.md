# Postgres-Migrationen statt `db push`

Stand: 2026-09-02 · Status: entworfen, freigegeben

## Kontext

Das Projekt fährt zwei Datenbankpfade. Solo/Dev nutzt SQLite mit echten
Migrationen (`prisma/migrations/`, sechs Stück). Der Docker-/Produktionspfad
nutzt PostgreSQL **ohne** Migrationen: Das Container-`CMD` führt beim Start

    npx prisma db push --schema=prisma/schema.postgres.prisma --skip-generate --accept-data-loss

aus. `docs/LIMITATIONEN.md` führt das als bekannte Einschränkung
("eigene Postgres-Migrationen sind Roadmap").

Zwei Folgen davon:

1. **Datenverlust ist im Startpfad erlaubt.** `--accept-data-loss` lässt den
   Container beim Hochfahren stillschweigend Spalten oder Tabellen entfernen,
   wenn das Schema das nahelegt. Auf einer Instanz mit festgeschriebenen
   Rechnungen steht das im Widerspruch zum GoBD-Kern des Projekts.
2. **Keine nachvollziehbare Schemahistorie.** Für § 146 AO / GoBD ist die
   Nachvollziehbarkeit von Systemänderungen relevant; `db push` hinterlässt
   keine.

Erschwerend pflegt das Projekt zwei Schemadateien von Hand
(`prisma/schema.prisma` für SQLite, `prisma/schema.postgres.prisma` für
Postgres). Sie sind bereits auseinandergelaufen: `RecurringInvoice` und
`RecurringInvoiceLine` fehlen im Postgres-Schema, wodurch `next build` im
Docker-Build abbricht. Upstream-PR #1 behebt das.

## Ziele

- `db push` im Startpfad durch `prisma migrate deploy` ersetzen,
  `--accept-data-loss` entfällt.
- Bestehende, per `db push` erzeugte Datenbanken lassen sich gefahrlos
  übernehmen — ohne dass der Container fremde Daten ungefragt anfasst.
- Ein wiederholbarer Weg, aus Schemaänderungen neue Postgres-Migrationen zu
  erzeugen (es stehen viele weitere Änderungen an).
- Auseinanderlaufen der beiden Schemadateien wird von der CI bemerkt.

## Nicht-Ziele

- Der SQLite-Pfad bleibt unverändert (eigene Migrationen, eigenes Verzeichnis).
- Keine Zusammenführung der beiden Schemadateien zu einer generierten Quelle.
  Das löst den Drift an der Wurzel, ist aber ein Eingriff in die
  Projektstruktur, den der Maintainer erst wollen muss. Der CI-Check macht den
  Drift sichtbar; die Wurzelbehandlung bleibt ein möglicher Folgeschritt.
- Keine Mehrmandanten-/RLS-Themen.

## Entscheidungen

### Zweite Config-Datei statt Verzeichnisumbau

Prisma sucht Migrationen neben dem Schema. Beide Schemadateien liegen in
`prisma/`, würden also beide auf `prisma/migrations/` (SQLite) zeigen. Ein
gemeinsames Verzeichnis ist ausgeschlossen: Die vorhandenen Migrationen sind
reines SQLite (`DATETIME`, `AUTOINCREMENT`, `PRAGMA`) und
`migration_lock.toml` pinnt den Provider.

Gewählt: eine zweite Datei `prisma.postgres.config.ts` mit eigenem
`migrations.path`. `prisma migrate deploy --config <pfad>` gibt es in der
eingesetzten Version 6.19.3. Rein additiv, keine bestehende Datei wird
verschoben.

Verworfen: `prisma/postgres/schema.prisma` mit eigenem `migrations/`.
Strukturell sauberer, verschiebt aber eine bestehende Datei und zieht
Pfadanpassungen in Dockerfile, CI und Doku nach sich — größere Angriffsfläche
für einen PR, der ohnehin Migrationsverhalten ändert.

### Zustand explizit abfragen, nicht Fehlertext auswerten

`prisma migrate deploy` erkennt laut Prisma-Doku **keinen Drift** und führt nur
Migrationsdateien aus. Auf einer db-push-Datenbank ohne
`_prisma_migrations`-Tabelle würde es die Baseline blind anwenden und an einem
PostgreSQL-Fehler ("relation already exists") scheitern — nicht an einem
stabilen Prisma-Fehlercode. Ein Abbruch, der auf Fehlertext-Parsing beruht,
bricht beim nächsten Versionswechsel.

Gewählt: Das Entrypoint-Skript fragt den Zustand vorher explizit ab, über den
ohnehin vorhandenen Prisma-Client. Keine zusätzliche Abhängigkeit.

## Architektur

### Neue und geänderte Dateien

| Datei | Zweck |
|---|---|
| `prisma.postgres.config.ts` | Schema `prisma/schema.postgres.prisma`, `migrations.path: prisma/migrations-postgres` |
| `prisma/migrations-postgres/0_init/migration.sql` | Baseline, erzeugt aus dem Postgres-Schema |
| `prisma/migrations-postgres/migration_lock.toml` | `provider = "postgresql"` |
| `scripts/docker-entrypoint.sh` | Startlogik, ersetzt den Einzeiler im `CMD` |
| `Dockerfile` | `CMD` ruft das Entrypoint-Skript |
| `package.json` | Skript `db:migrate:pg` |
| `.github/workflows/ci.yml` | Job `schema-drift` |
| `docs/LIMITATIONEN.md` | Einschränkung streichen |
| `README.md` / `README.de.md` | Hinweis für Bestandsinstanzen |

Die Baseline entsteht mit:

    npx prisma migrate diff --from-empty \
      --to-schema-datamodel prisma/schema.postgres.prisma \
      --script > prisma/migrations-postgres/0_init/migration.sql

(In 6.19.3 heißt der Flag `--to-schema-datamodel`; die v7-Doku nennt
`--to-schema`.)

### Startablauf

Das Entrypoint-Skript prüft zwei Dinge: Gibt es die Tabelle
`_prisma_migrations`? Gibt es Anwendungstabellen (stellvertretend
`"Organization"`)?

| Historie | Tabellen | Verhalten |
|---|---|---|
| ja | — | `migrate deploy`, dann App starten |
| nein | nein | frische DB → `migrate deploy`, dann App starten |
| nein | ja | **Abbruch** mit Exit-Code ≠ 0 |

Im Abbruchfall nennt die Meldung genau den auszuführenden Befehl:

    docker compose run --rm app \
      npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init

Der Container fasst in diesem Fall nichts an. `--accept-data-loss` kommt im
gesamten Startpfad nicht mehr vor.

### Folgemigrationen

Für künftige Schemaänderungen — davon stehen viele an:

    npm run db:migrate:pg -- --name <beschreibung>

entspricht `prisma migrate dev --config prisma.postgres.config.ts`. Läuft gegen
den Compose-Postgres; die Shadow-Datenbank legt Prisma selbst an und wieder ab
(der Compose-Benutzer `oig` hat die nötigen Rechte). Der SQLite-Weg
(`npm run db:migrate`) bleibt unverändert daneben bestehen.

Beide Schemadateien müssen bei einer Modelländerung gepflegt werden — der
CI-Job unten erzwingt das.

### CI-Job `schema-drift`

Vergleicht beide Schemadateien nach Normalisierung der Provider-Zeile; sie
müssen ansonsten zeichengleich sein. Überprüft: Außer der Datasource-Zeile und
den fehlenden Modellen gibt es aktuell keinen Unterschied, die Annahme trägt.

Schlägt der Vergleich fehl, gibt der Job die abweichenden Zeilen aus und
beendet sich mit Fehler.

## Umstellung bestehender Instanzen

Betrifft jede Instanz, die dem README gefolgt ist — die Datenbank wurde per
`db push` erzeugt und hat keine Migrationshistorie. Reihenfolge:

1. Backup ziehen.
2. Update einspielen; der Container bricht mit der Anleitung ab (Fall 3).
3. Genannten `migrate resolve --applied 0_init` ausführen.
4. Neu starten; ab hier läuft `migrate deploy` normal.

Wird in beiden READMEs dokumentiert.

## Tests

- Die bestehende Integrationstest-Suite läuft gegen SQLite und bleibt unberührt.
- Neu: Skripttests für die drei Startfälle gegen einen Wegwerf-Postgres-Container.
  Fall 3 (Abbruch) muss belegt sein, nicht behauptet — geprüft wird, dass der
  Container mit Exit-Code ≠ 0 endet, die Anleitung ausgibt und die
  vorhandenen Daten unverändert lässt.
- `npm run typecheck`, `lint`, `test`, `build`, `validate:erechnung` bleiben grün.

## Abhängigkeiten und Risiken

**Setzt auf Upstream-PR #1 auf.** Die Baseline wird aus
`schema.postgres.prisma` erzeugt; solange dort `RecurringInvoice` fehlt, wäre
sie unvollständig. Die Baseline entsteht aus dem korrigierten Schema.

**Risiko: falsche Baseline bei abweichender Bestands-DB.** Wurde eine
Instanz per `db push` auf einen Schemastand gebracht, der von `0_init`
abweicht, verbucht `migrate resolve --applied` eine Baseline, die nicht dem
tatsächlichen Zustand entspricht — spätere Migrationen laufen dann auf falschen
Annahmen. Gegenmittel: Die Dokumentation weist auf das Backup hin und darauf,
den Schemastand vorher zu prüfen. Automatisches Baselining wurde genau deshalb
verworfen.

**Risiko: PR bleibt liegen.** Upstream hat vier offene PRs seit dem
2026-08-22 und keine Issues. Die Änderung ist im eigenen Fork sofort nutzbar,
unabhängig vom Merge-Zeitpunkt.
