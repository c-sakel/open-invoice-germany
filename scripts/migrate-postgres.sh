#!/usr/bin/env bash
# Erzeugt eine PostgreSQL-Migration und stellt danach den SQLite-Client wieder her.
#
# Beide Schemadateien generieren den Prisma-Client in denselben Pfad
# (src/generated/prisma). "prisma migrate dev" erzeugt ihn am Ende neu — ohne den
# abschliessenden "prisma generate"-Lauf bliebe der Postgres-Client liegen, und
# "npm test" sowie "npm run dev" scheiterten danach mit einem irrefuehrenden
# Protokollfehler.
#
# Argumente werden an "migrate dev" durchgereicht:
#   npm run db:migrate:pg -- --name kunden_notizfeld
set -euo pipefail
cd "$(dirname "$0")/.."

npx prisma migrate dev --config prisma.postgres.config.ts "$@"
npx prisma generate
