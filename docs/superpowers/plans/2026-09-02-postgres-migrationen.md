# Postgres-Migrationen statt `db push` — Umsetzungsplan

> **Für agentische Bearbeiter:** ERFORDERLICHES SUB-SKILL: `superpowers:subagent-driven-development` (empfohlen) oder `superpowers:executing-plans`. Schritte nutzen Checkbox-Syntax (`- [ ]`).

**Ziel:** Der PostgreSQL-Pfad nutzt echte Prisma-Migrationen statt `prisma db push --accept-data-loss`; bestehende Datenbanken werden erkannt und nie ungefragt verändert.

**Architektur:** Eine zweite Prisma-Config (`prisma.postgres.config.ts`) mit eigenem Migrationsverzeichnis, weil `migration_lock.toml` den Provider festschreibt und die vorhandenen Migrationen reines SQLite sind. Ein Entrypoint-Skript prüft den Datenbankzustand über eigenes SQL, bevor `migrate deploy` läuft. Ein CI-Job vergleicht die beiden Schemadateien.

**Tech-Stack:** Prisma 6.19.3, Node 22, PostgreSQL 16, Docker, GitHub Actions, Vitest (unberührt).

**Spec:** `docs/superpowers/specs/2026-09-02-postgres-migrationen-design.md`

## Globale Randbedingungen

- Branch entsteht aus `upstream/main`: `git checkout -b fix/postgres-migrations upstream/main`
- Jeder Commit mit DCO-Signoff: `git commit -s` (CONTRIBUTING.md)
- Projektsprache in Code-Kommentaren und Doku: **Deutsch**
- TypeScript strict, kein `any`
- Vor dem PR müssen grün sein: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run validate:erechnung`
- Der SQLite-Pfad (`prisma/schema.prisma`, `prisma/migrations/`, `prisma.config.ts`) wird **nicht** verändert

## Verifizierte Fakten (bereits empirisch geprüft — nicht erneut hinterfragen)

1. Die Prisma-CLI lädt `prisma.config.ts` aus dem Arbeitsverzeichnis **automatisch**. Deren `migrations.path` überschreibt das schema-benachbarte Verzeichnis. `--config` ist daher bei **jedem** Postgres-Migrationsbefehl zwingend, sonst greift Prisma auf die SQLite-Migrationen zu und bricht ab mit: `The datasource provider postgresql specified in your schema does not match the one specified in the migration_lock.toml, sqlite`.
2. `defineConfig` **braucht** einen expliziten `datasource`-Block. Ohne ihn: `Error: Cannot destructure property 'url' of 'g' as it is undefined.` Es gibt keinen Rückfall auf `env("DATABASE_URL")` aus dem Schema.
3. In Prisma 6.19.3 heißt der Flag `--to-schema-datamodel` (nicht `--to-schema` wie in der v7-Doku).
4. `prisma db execute --url "$DATABASE_URL" --file <datei>` beendet sich mit Code 1, wenn das SQL eine Exception wirft. Der Marker-Text erscheint auf stderr.
5. Die Baseline aus dem korrigierten Postgres-Schema umfasst 402 Zeilen und legt 15 Tabellen an (14 Modelle + `_prisma_migrations`).

---

### Task 1: Postgres-Config, Schema-Korrektur und Baseline-Migration

**Dateien:**
- Erstellen: `prisma.postgres.config.ts`
- Erstellen: `prisma/migrations-postgres/migration_lock.toml`
- Erstellen: `prisma/migrations-postgres/0_init/migration.sql` (generiert)
- Ändern: `prisma/schema.postgres.prisma` (fehlende Modelle ergänzen)
- Erstellen: `scripts/test-postgres-migrations.sh`

**Schnittstellen:**
- Erzeugt: Config-Pfad `prisma.postgres.config.ts` und Migrationsverzeichnis `prisma/migrations-postgres`, beide von Task 2, 3 und 4 verwendet.
- Erzeugt: Testskript `scripts/test-postgres-migrations.sh`, von Task 2 erweitert und von Task 4 in der CI aufgerufen.

**Hinweis zur Schema-Korrektur:** `prisma/schema.postgres.prisma` fehlen `RecurringInvoice` und `RecurringInvoiceLine`. Upstream-PR #1 behebt genau das. Wir nehmen dieselbe Korrektur auf, damit dieser PR eigenständig grün ist; in der PR-Beschreibung wird #1 genannt und angeboten, den Teil bei früherem Merge zu entfernen. Beide Dateien sind ausser der Provider-Zeile zeichengleich — die Korrektur entsteht deshalb durch Ableitung, nicht durch Abtippen.

- [ ] **Schritt 1: Testskript mit dem Fall „frische Datenbank" schreiben**

Datei `scripts/test-postgres-migrations.sh`:

```bash
#!/usr/bin/env bash
# Testet den Postgres-Migrationspfad gegen einen Wegwerf-Container.
# Voraussetzung: laufender Docker-Daemon. Aufruf: ./scripts/test-postgres-migrations.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=oig-migtest
PORT=55433
export DATABASE_URL="postgresql://oig:test@localhost:${PORT}/openinvoice?schema=public"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "==> Wegwerf-PostgreSQL starten"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=oig -e POSTGRES_PASSWORD=test -e POSTGRES_DB=openinvoice \
  -p "${PORT}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U oig -d openinvoice >/dev/null 2>&1 && break
  sleep 1
done

fail() { echo "FEHLGESCHLAGEN: $1" >&2; exit 1; }

echo "==> Fall 1: frische Datenbank"
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null
COUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT" = "15" ] || fail "erwartet 15 Tabellen, gefunden $COUNT"
echo "    ok — 15 Tabellen angelegt"

echo "ALLE TESTS BESTANDEN"
```

Ausführbar machen: `chmod +x scripts/test-postgres-migrations.sh`

- [ ] **Schritt 2: Test ausführen und Fehlschlag bestätigen**

Ausführen: `./scripts/test-postgres-migrations.sh`
Erwartet: FEHLER — `prisma.postgres.config.ts` existiert noch nicht.

- [ ] **Schritt 3: Postgres-Schema aus dem SQLite-Schema ableiten**

Die beiden Dateien unterscheiden sich nur in der Provider-Zeile. Ableiten statt abtippen:

```bash
sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma \
  > prisma/schema.postgres.prisma
```

Prüfen, dass jetzt beide Abo-Modelle enthalten sind:

```bash
grep -c "model RecurringInvoice" prisma/schema.postgres.prisma   # erwartet: 2
```

- [ ] **Schritt 4: Postgres-Config anlegen**

Datei `prisma.postgres.config.ts`:

```typescript
// Prisma-Konfiguration fuer den PostgreSQL-Pfad (Docker/Produktion).
//
// Eigene Datei, weil migration_lock.toml den Provider festschreibt: SQLite- und
// Postgres-Migrationen koennen sich kein Verzeichnis teilen. Die CLI laedt
// prisma.config.ts automatisch aus dem Arbeitsverzeichnis — deren migrations.path
// zeigt auf die SQLite-Migrationen. Postgres-Befehle brauchen deshalb immer
// "--config prisma.postgres.config.ts".
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.postgres.prisma",
  migrations: {
    path: "prisma/migrations-postgres",
  },
  engine: "classic",
  datasource: {
    // Der Block ist Pflicht: ohne ihn bricht die CLI mit
    // "Cannot destructure property 'url'" ab. Ein Rueckfall auf env("DATABASE_URL")
    // aus dem Schema findet nicht statt.
    url: process.env.DATABASE_URL ?? "",
  },
});
```

- [ ] **Schritt 5: Migrationsverzeichnis und Baseline erzeugen**

```bash
mkdir -p prisma/migrations-postgres/0_init
printf 'provider = "postgresql"\n' > prisma/migrations-postgres/migration_lock.toml
npx prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/schema.postgres.prisma \
  --script > prisma/migrations-postgres/0_init/migration.sql
```

Prüfen: `wc -l prisma/migrations-postgres/0_init/migration.sql` — erwartet rund 402 Zeilen, beginnend mit `-- CreateSchema`.

- [ ] **Schritt 6: Test ausführen und Erfolg bestätigen**

Ausführen: `./scripts/test-postgres-migrations.sh`
Erwartet: `ALLE TESTS BESTANDEN`

- [ ] **Schritt 7: Commit**

```bash
git add prisma.postgres.config.ts prisma/migrations-postgres prisma/schema.postgres.prisma scripts/test-postgres-migrations.sh
git commit -s -m "feat(db): Postgres-Migrationsverzeichnis mit Baseline

Zweite Prisma-Config fuer den Postgres-Pfad; SQLite- und Postgres-Migrationen
koennen sich kein Verzeichnis teilen, weil migration_lock.toml den Provider
festschreibt.

schema.postgres.prisma wird dabei aus schema.prisma abgeleitet — dort fehlten
RecurringInvoice und RecurringInvoiceLine (siehe #1), wodurch die Baseline
unvollstaendig gewesen waere."
```

---

### Task 2: Zustandsprüfung und Entrypoint

**Dateien:**
- Erstellen: `scripts/check-baseline.sql`
- Erstellen: `scripts/docker-entrypoint.sh`
- Ändern: `Dockerfile` (letzte Zeile, `CMD`)
- Ändern: `scripts/test-postgres-migrations.sh` (Fälle 2 und 3 ergänzen)

**Schnittstellen:**
- Konsumiert: `prisma.postgres.config.ts` und `prisma/migrations-postgres/` aus Task 1.
- Erzeugt: `scripts/docker-entrypoint.sh` als neues `CMD` des Images.

- [ ] **Schritt 1: Testfälle 2 und 3 ergänzen**

In `scripts/test-postgres-migrations.sh` vor der Zeile `echo "ALLE TESTS BESTANDEN"` einfügen:

```bash
echo "==> Datenbank leeren und Bestandslage herstellen"
docker exec "$CONTAINER" psql -U oig -d openinvoice \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null
npx prisma db push --schema prisma/schema.postgres.prisma \
  --skip-generate --accept-data-loss >/dev/null

echo "==> Fall 2: Bestands-DB ohne Historie wird erkannt"
if OUT=$(./scripts/docker-entrypoint.sh 2>&1); then
  fail "Entrypoint haette abbrechen muessen"
fi
printf '%s' "$OUT" | grep -q "migrate resolve" \
  || fail "Abbruchmeldung nennt den noetigen Befehl nicht"
COUNT=$(docker exec "$CONTAINER" psql -U oig -d openinvoice -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
[ "$COUNT" = "14" ] || fail "Entrypoint hat die Daten veraendert ($COUNT Tabellen)"
echo "    ok — abgebrochen, Daten unveraendert"

echo "==> Fall 3: nach Baseline laeuft deploy durch"
npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init >/dev/null
npx prisma migrate deploy --config prisma.postgres.config.ts 2>&1 \
  | grep -q "No pending migrations" || fail "deploy war nicht wirkungslos"
echo "    ok — Baseline verbucht, deploy wirkungslos"
```

Hinweis: In Fall 2 wird das Entrypoint-Skript direkt aufgerufen. Es startet die
App nur, wenn die Prüfung durchläuft — im Abbruchfall endet es vorher.

- [ ] **Schritt 2: Test ausführen und Fehlschlag bestätigen**

Ausführen: `./scripts/test-postgres-migrations.sh`
Erwartet: FEHLER — `scripts/docker-entrypoint.sh` existiert noch nicht.

- [ ] **Schritt 3: Prüf-SQL anlegen**

Datei `scripts/check-baseline.sql`:

```sql
-- Bricht ab, wenn Anwendungstabellen existieren, aber keine Migrationshistorie.
-- Das ist genau der Zustand einer per "prisma db push" erzeugten Bestandsdatenbank.
--
-- Der Marker ist bewusst ein eigener Text: "prisma migrate deploy" erkennt laut
-- Prisma-Doku keinen Drift und wuerde die Baseline blind anwenden, sodass ein
-- PostgreSQL-Fehler entstuende statt eines stabilen Prisma-Fehlercodes.
-- Eigenes SQL bleibt ueber Versionswechsel hinweg verlaesslich.
DO $$
BEGIN
  IF to_regclass('public."Organization"') IS NOT NULL
     AND to_regclass('public."_prisma_migrations"') IS NULL
  THEN
    RAISE EXCEPTION 'OIG_BASELINE_REQUIRED';
  END IF;
END
$$;
```

- [ ] **Schritt 4: Entrypoint-Skript anlegen**

Datei `scripts/docker-entrypoint.sh`:

```bash
#!/bin/sh
# Startet die Anwendung. Vorher wird der Datenbankzustand geprueft und es werden
# ausstehende Migrationen angewendet.
#
# Frueher lief hier "prisma db push --accept-data-loss". Das durfte beim
# Hochfahren stillschweigend Spalten und Tabellen entfernen — auf einer Instanz
# mit festgeschriebenen Rechnungen unvereinbar mit dem GoBD-Kern des Projekts.
set -eu

CONFIG=prisma.postgres.config.ts

if ! probe=$(npx prisma db execute --url "$DATABASE_URL" \
             --file scripts/check-baseline.sql 2>&1); then
  if printf '%s' "$probe" | grep -q OIG_BASELINE_REQUIRED; then
    cat >&2 <<'MELDUNG'
FEHLER: Diese Datenbank wurde mit "prisma db push" angelegt und hat keine
Migrationshistorie. Sie wird nicht automatisch uebernommen.

Umstellung (vorher ein Backup ziehen):

  docker compose run --rm app \
    npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init

Danach startet der Container normal.
MELDUNG
    exit 1
  fi
  printf '%s\n' "$probe" >&2
  echo "FEHLER: Datenbankpruefung fehlgeschlagen." >&2
  exit 1
fi

npx prisma migrate deploy --config "$CONFIG"
exec npx next start -p 3000
```

Ausführbar machen: `chmod +x scripts/docker-entrypoint.sh`

- [ ] **Schritt 5: Dockerfile umstellen**

Im `runner`-Abschnitt die `CMD`-Zeile ersetzen. Vorher:

```dockerfile
CMD ["sh", "-c", "npx prisma db push --schema=prisma/schema.postgres.prisma --skip-generate --accept-data-loss && npx next start -p 3000"]
```

Nachher — davor muss das Skript ins Image kopiert werden:

```dockerfile
COPY --from=build /app/scripts ./scripts
CMD ["sh", "./scripts/docker-entrypoint.sh"]
```

Die `COPY`-Zeile gehört zu den übrigen `COPY --from=build`-Zeilen, direkt vor `EXPOSE 3000`.

- [ ] **Schritt 6: Test ausführen und Erfolg bestätigen**

Ausführen: `./scripts/test-postgres-migrations.sh`
Erwartet: `ALLE TESTS BESTANDEN`

- [ ] **Schritt 7: Docker-Build prüfen**

```bash
docker build -t oig-migrations-test .
```
Erwartet: Build läuft durch. Danach aufräumen: `docker rmi oig-migrations-test`

- [ ] **Schritt 8: Commit**

```bash
git add scripts/check-baseline.sql scripts/docker-entrypoint.sh scripts/test-postgres-migrations.sh Dockerfile
git commit -s -m "feat(docker): migrate deploy statt db push beim Start

Der Container prueft den Datenbankzustand mit eigenem SQL, bevor Migrationen
laufen. Eine per db push erzeugte Bestandsdatenbank wird erkannt; der Start
bricht mit der noetigen Anweisung ab, statt Daten anzufassen.

--accept-data-loss kommt im Startpfad nicht mehr vor."
```

---

### Task 3: Skript für Folgemigrationen

**Dateien:**
- Ändern: `package.json` (Abschnitt `scripts`)
- Ändern: `CONTRIBUTING.md`

**Schnittstellen:**
- Konsumiert: `prisma.postgres.config.ts` aus Task 1.

- [ ] **Schritt 1: npm-Skript ergänzen**

In `package.json` nach der Zeile `"db:migrate": "prisma migrate dev",` einfügen:

```json
    "db:migrate:pg": "prisma migrate dev --config prisma.postgres.config.ts",
```

- [ ] **Schritt 2: Aufruf prüfen**

Bei laufendem Compose-Postgres und gesetzter `DATABASE_URL`:

```bash
npm run db:migrate:pg -- --name test_migration
```
Erwartet: Prisma legt eine Migration unter `prisma/migrations-postgres/` an. Danach die Testmigration wieder entfernen:
```bash
rm -rf prisma/migrations-postgres/*_test_migration
```

- [ ] **Schritt 3: CONTRIBUTING ergänzen**

Im Abschnitt „Entwicklungs-Setup" nach dem Codeblock einfügen:

```markdown
Schemaänderungen betreffen **beide** Schemadateien. `prisma/schema.postgres.prisma`
unterscheidet sich von `prisma/schema.prisma` nur in der Provider-Zeile und wird
abgeleitet:

    sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma \
      > prisma/schema.postgres.prisma

Danach je eine Migration pro Provider erzeugen:

    npm run db:migrate    -- --name <beschreibung>   # SQLite
    npm run db:migrate:pg -- --name <beschreibung>   # PostgreSQL (Compose-DB muss laufen)

Der CI-Job `schema-drift` schlägt fehl, wenn die beiden Dateien auseinanderlaufen.
```

- [ ] **Schritt 4: Commit**

```bash
git add package.json CONTRIBUTING.md
git commit -s -m "feat(db): npm-Skript fuer Postgres-Folgemigrationen"
```

---

### Task 4: CI-Job gegen Schema-Drift

**Dateien:**
- Ändern: `.github/workflows/ci.yml`

**Schnittstellen:**
- Konsumiert: `scripts/test-postgres-migrations.sh` aus Task 1 und 2.

- [ ] **Schritt 1: Vergleich lokal prüfen**

```bash
diff <(sed 's/provider = "sqlite"/PROVIDER/' prisma/schema.prisma) \
     <(sed 's/provider = "postgresql"/PROVIDER/' prisma/schema.postgres.prisma) \
  && echo "identisch"
```
Erwartet nach Task 1: `identisch`

- [ ] **Schritt 2: Jobs ergänzen**

In `.github/workflows/ci.yml` am Ende anfügen:

```yaml
  # Die beiden Schemadateien sind bis auf die Provider-Zeile zeichengleich.
  # Laufen sie auseinander, entstehen unvollstaendige Postgres-Migrationen —
  # genau so fehlten RecurringInvoice/RecurringInvoiceLine ueber Monate.
  schema-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Schemadateien vergleichen
        run: |
          diff <(sed 's/provider = "sqlite"/PROVIDER/' prisma/schema.prisma) \
               <(sed 's/provider = "postgresql"/PROVIDER/' prisma/schema.postgres.prisma) \
            && echo "Schemadateien sind deckungsgleich."

  postgres-migrations:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm install --no-audit --no-fund
      - run: ./scripts/test-postgres-migrations.sh
```

- [ ] **Schritt 3: YAML-Syntax prüfen**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML ok')"
```
Erwartet: `YAML ok`

- [ ] **Schritt 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -s -m "ci: Schema-Drift und Postgres-Migrationen pruefen"
```

---

### Task 5: Dokumentation

**Dateien:**
- Ändern: `docs/LIMITATIONEN.md`
- Ändern: `README.md`
- Ändern: `README.de.md`

- [ ] **Schritt 1: LIMITATIONEN aktualisieren**

Die Zeile

```markdown
- **PostgreSQL** nutzt im Docker-Setup vorerst `prisma db push` (eigene Postgres-Migrationen sind Roadmap). Solo/SQLite nutzt echte Migrationen.
```

ersetzen durch:

```markdown
- **PostgreSQL** nutzt echte Migrationen (`prisma/migrations-postgres/`, angewendet beim Containerstart). Bestehende Instanzen, die noch mit `prisma db push` angelegt wurden, müssen einmalig eine Baseline verbuchen — der Container bricht mit der nötigen Anweisung ab, statt die Datenbank anzufassen.
```

- [ ] **Schritt 2: README.de.md ergänzen**

Im Abschnitt „Mit Docker (PostgreSQL + ZUGFeRD-Sidecar)" nach dem Codeblock einfügen:

```markdown
**Bestehende Instanz aktualisieren.** Wurde die Datenbank mit einer älteren Version
per `prisma db push` angelegt, fehlt ihr die Migrationshistorie. Der Container
startet dann nicht, sondern nennt den einmalig nötigen Befehl. Vorher ein Backup
ziehen, dann:

```bash
docker compose run --rm app \
  npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init
```

Danach startet der Container normal; künftige Schemaänderungen laufen über
`prisma migrate deploy`.
```

- [ ] **Schritt 3: README.md ergänzen (englisch)**

Analoge Ergänzung im entsprechenden Docker-Abschnitt:

```markdown
**Upgrading an existing instance.** If the database was created with an older
version using `prisma db push`, it has no migration history. The container will
refuse to start and print the one command needed. Take a backup first, then:

```bash
docker compose run --rm app \
  npx prisma migrate resolve --config prisma.postgres.config.ts --applied 0_init
```

After that the container starts normally and future schema changes go through
`prisma migrate deploy`.
```

- [ ] **Schritt 4: Vollständige Prüfkette**

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run validate:erechnung
```
Erwartet: alles grün, 56 Tests bestanden.

- [ ] **Schritt 5: Commit**

```bash
git add docs/LIMITATIONEN.md README.md README.de.md
git commit -s -m "docs: Postgres-Migrationen und Umstieg fuer Bestandsinstanzen"
```

---

## Nach Abschluss

- [ ] Branch pushen: `git push -u origin fix/postgres-migrations`
- [ ] PR-Text vorbereiten; #1 nennen und anbieten, die Schema-Korrektur bei früherem Merge zu entfernen
- [ ] PR **nicht** ohne ausdrückliche Freigabe öffnen
- [ ] Umstellung der Produktivinstanz `invoice.prepaid-host.com` ist ein separater, bewusster Schritt nach Backup — nicht Teil dieses Plans
