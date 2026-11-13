#!/usr/bin/env bash
# Parallel-Lasttest unter PostgreSQL (Phase 17b): prueft die Zeilensperren (lockRow) und
# atomare Zahlungen gegen einen Wegwerf-Container. Voraussetzung: laufender Docker-Daemon.
# Aufruf: ./scripts/test-postgres-race.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=oig-racetest
PORT=55434
export DATABASE_URL="postgresql://oig:test@localhost:${PORT}/openinvoice?schema=public"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
cleanup_all() { cleanup; rm -rf tmp/pg-race; }
trap cleanup_all EXIT
cleanup

fail() { echo "FEHLGESCHLAGEN: $1" >&2; exit 1; }

echo "==> Wegwerf-PostgreSQL starten"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER=oig -e POSTGRES_PASSWORD=test -e POSTGRES_DB=openinvoice \
  -p "${PORT}:5432" postgres:16-alpine >/dev/null
ready=0
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U oig -d openinvoice >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
[ "$ready" = "1" ] || fail "PostgreSQL wurde nicht bereit"
# pg_isready meldet bereits waehrend des Initialisierungslaufs; kurz auf den Neustart warten.
sleep 2

echo "==> Migrationen anwenden"
npx prisma migrate deploy --config prisma.postgres.config.ts >/dev/null  # nur stdout verwerfen, stderr bleibt fuer die Diagnose

echo "==> Postgres-Client getrennt erzeugen (src/generated/prisma bleibt unveraendert)"
rm -rf tmp/pg-race
mkdir -p tmp/pg-race
sed 's#"../src/generated/prisma"#"./client"#' prisma/schema.postgres.prisma > tmp/pg-race/schema.prisma
cat > tmp/pg-race/prisma.config.ts <<'CFG'
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "schema.prisma",
  engine: "classic",
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
CFG
npx prisma generate --config tmp/pg-race/prisma.config.ts >/dev/null  # nur stdout verwerfen
[ -f tmp/pg-race/client/client.ts ] || fail "Postgres-Client wurde nicht erzeugt (tmp/pg-race/client/client.ts)"

echo "==> Parallel-Tests"
npx vitest run --config vitest.postgres.config.ts
echo "OK — Parallel-Lasttest bestanden"
