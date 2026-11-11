#!/usr/bin/env bash
# Restore-Test (Phase 16a, Vorlage): spielt eine verschluesselte Sicherung in einen temporaeren
# postgres:16-Container ein und prueft sie. Der Container wird IMMER entfernt (trap).
#
#   restore-test.sh <backup-datei.tar.enc>
#   BACKUP_PASSPHRASE_FILE  Passphrasen-Datei (Pflicht, Modus 600)
#
# Pruefungen: Migrationsstand (prisma migrate status), Zeilenzahlen gegen manifest.txt,
# Hash-Kette (scripts/verify-chain.ts), 5 zufaellige Archivdateien per sha256sum gegen die Datenbank.
# Letzte Ausgabezeile: "OK <datei>" bzw. "FEHLER <grund>" (Exit 0 / 1). Aus dem Projektverzeichnis starten.
set -euo pipefail

WORK=""
CONTAINER=""
cleanup() {
  [ -z "$CONTAINER" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap cleanup EXIT
fail() { echo "FEHLER $*"; exit 1; }
trap 'fail "unerwarteter Abbruch in Zeile $LINENO"' ERR

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

BACKUP="${1:-}"
[ -n "$BACKUP" ] || fail "Aufruf: restore-test.sh <backup-datei.tar.enc>"
[ -f "$BACKUP" ] || fail "Sicherung nicht gefunden: $BACKUP"
PASS_FILE="${BACKUP_PASSPHRASE_FILE:-}"
[ -n "$PASS_FILE" ] && [ -f "$PASS_FILE" ] || fail "BACKUP_PASSPHRASE_FILE fehlt oder nicht gefunden"
[ "$(file_mode "$PASS_FILE")" = "600" ] || fail "Passphrasen-Datei muss Modus 600 haben"
for tool in docker openssl tar sha256sum npx; do
  command -v "$tool" >/dev/null 2>&1 || fail "Werkzeug fehlt: $tool"
done

WORK="$(mktemp -d)"
openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$PASS_FILE" -in "$BACKUP" -out "$WORK/payload.tar" \
  || fail "Entschluesselung fehlgeschlagen (falsche Passphrase oder beschaedigte Datei)"
mkdir -p "$WORK/x" "$WORK/archive"
tar -xf "$WORK/payload.tar" -C "$WORK/x"
for f in db.sql.gz archive.tar.gz manifest.txt; do [ -f "$WORK/x/$f" ] || fail "Sicherung unvollstaendig: $f fehlt"; done
tar -xzf "$WORK/x/archive.tar.gz" -C "$WORK/archive"

PGPASS="restore-$(date +%s)"
CONTAINER="oig-restore-test-$$"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=restore -p 127.0.0.1::5432 postgres:16 >/dev/null \
  || fail "Container konnte nicht gestartet werden"
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres -d restore >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres -d restore >/dev/null 2>&1 || fail "temporaere Datenbank nicht bereit"
PORT="$(docker port "$CONTAINER" 5432/tcp | head -n1 | sed 's/.*://')"
export DATABASE_URL="postgresql://postgres:${PGPASS}@127.0.0.1:${PORT}/restore?schema=public"
psql_q() { docker exec -i "$CONTAINER" psql -U postgres -d restore -Atc "$1"; }

gunzip -c "$WORK/x/db.sql.gz" | docker exec -i "$CONTAINER" psql -U postgres -d restore -v ON_ERROR_STOP=1 -q >/dev/null \
  || fail "Einspielen des Dumps fehlgeschlagen"

# 1. Migrationsstand
npx prisma migrate status --config prisma.postgres.config.ts >"$WORK/migrate.log" 2>&1 \
  || { cat "$WORK/migrate.log" >&2; fail "prisma migrate status meldet Abweichung"; }

# 2. Zeilenzahlen gegen das Manifest
while IFS='=' read -r key expected; do
  case "$key" in Invoice | Payment | ChangeLog | ArchivedDocument | Dunning) ;; *) continue ;; esac
  actual="$(psql_q "SELECT count(*) FROM \"$key\"")"
  [ "$actual" = "$expected" ] || fail "Manifest-Abweichung $key: erwartet $expected, gefunden $actual"
done < "$WORK/x/manifest.txt"

# 3. Hash-Kette
npx tsx scripts/verify-chain.ts >"$WORK/chain.log" 2>&1 || { cat "$WORK/chain.log" >&2; fail "Hash-Kette defekt"; }

# 4. fuenf zufaellige Archivdateien
while IFS='|' read -r path sha; do
  [ -n "$path" ] || continue
  [ -f "$WORK/archive/$path" ] || fail "Archivdatei fehlt: $path"
  actual="$(sha256sum "$WORK/archive/$path" | awk '{print $1}')"
  [ "$actual" = "$sha" ] || fail "Archiv-Hash weicht ab: $path"
done < <(psql_q 'SELECT path || chr(124) || sha256 FROM "ArchivedDocument" ORDER BY random() LIMIT 5')

trap - ERR
echo "OK $BACKUP"
