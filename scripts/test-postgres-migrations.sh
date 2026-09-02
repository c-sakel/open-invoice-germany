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

echo "ALLE TESTS BESTANDEN"
