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
