#!/usr/bin/env bash
# Verschluesselte Sicherung (Phase 16a, Vorlage): Datenbank, Beleganhaenge, Belegarchiv, .env, Manifest.
# Aufruf aus dem Projektverzeichnis (siehe docs/BETRIEB-VORLAGE.md). Konfiguration per Umgebung
# bzw. .env — KEINE Zugangsdaten in diesem Skript.
#
#   DATABASE_URL            PostgreSQL-URL (Pflicht; Sonderzeichen im Passwort prozent-kodiert)
#   ATTACHMENTS_DIR         Default ./data/attachments
#   ARCHIVE_DIR             Default ./data/archive
#   ENV_FILE                Default ./.env (wird mitgesichert, falls vorhanden)
#   BACKUP_DIR              lokales Zielverzeichnis, Default ./backups
#   BACKUP_PASSPHRASE_FILE  Datei mit der Passphrase (Pflicht, Modus 600)
#   BACKUP_TARGET           optional: rsync:user@host:/pfad | s3:bucket/prefix
#   BACKUP_KEEP_LOCAL       Anzahl lokaler Sicherungen (Default 30)
#   BACKUP_KEEP_REMOTE      Aufbewahrung am Ziel in Tagen (Default 90)
#   BACKUP_STATUS_FILE      optional: Statusdatei, je Lauf eine Zeile "OK <ISO>" bzw. "FEHLER <ISO> <grund>"
#   PG_DUMP_CONTAINER       optional: Name des DB-Containers; pg_dump laeuft dann dort
#                           (passende Server-Version), Verbindungsdaten nur per -e PG* (nie in argv)
# Letzte Ausgabezeile: "OK <datei>" bzw. "FEHLER <grund>" (Exit 0 / 1).
set -euo pipefail
umask 077

STATUS_FILE="${BACKUP_STATUS_FILE:-}"
WORK=""

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_status() {
  [ -n "$STATUS_FILE" ] || return 0
  { echo "$1"; } >> "$STATUS_FILE" 2>/dev/null || return 0
  # Datei klein halten: nur die letzten 200 Zeilen.
  tail -n 200 "$STATUS_FILE" > "$STATUS_FILE.tmp" 2>/dev/null && mv "$STATUS_FILE.tmp" "$STATUS_FILE" || true
}

cleanup() { [ -z "$WORK" ] || rm -rf "$WORK"; }
trap cleanup EXIT

fail() {
  echo "FEHLER $*"
  write_status "FEHLER $(now_iso) $*"
  exit 1
}
trap 'fail "unerwarteter Abbruch in Zeile $LINENO"' ERR

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# Grenze als Zeitstempel im Dateinamenformat (UTC) fuer die entfernte Rotation per Listing.
cutoff_stamp() {
  local days="$1"
  date -u -d "-${days} days" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-"${days}"d +%Y%m%dT%H%M%SZ
}

# ---------------------------------------------------------------- Pruefungen
PASS_FILE="${BACKUP_PASSPHRASE_FILE:-}"
[ -n "$PASS_FILE" ] || fail "BACKUP_PASSPHRASE_FILE ist nicht gesetzt"
[ -f "$PASS_FILE" ] || fail "Passphrasen-Datei nicht gefunden: $PASS_FILE"
[ "$(file_mode "$PASS_FILE")" = "600" ] || fail "Passphrasen-Datei muss Modus 600 haben: $PASS_FILE"

TARGET="${BACKUP_TARGET:-}"
case "$TARGET" in
  "" | rsync:* | s3:*) ;;
  *) fail "unbekanntes BACKUP_TARGET (erlaubt: rsync:user@host:/pfad, s3:bucket/prefix)" ;;
esac

KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-30}"
KEEP_REMOTE="${BACKUP_KEEP_REMOTE:-90}"
[[ "$KEEP_LOCAL" =~ ^[0-9]+$ ]] || fail "BACKUP_KEEP_LOCAL muss eine Ganzzahl sein"
[[ "$KEEP_REMOTE" =~ ^[0-9]+$ ]] || fail "BACKUP_KEEP_REMOTE muss eine Ganzzahl sein"

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL ist nicht gesetzt"
PG_DUMP_CONTAINER="${PG_DUMP_CONTAINER:-}"
DUMP_TOOL="pg_dump"
[ -z "$PG_DUMP_CONTAINER" ] || DUMP_TOOL="docker"
for tool in "$DUMP_TOOL" tar openssl gzip; do
  command -v "$tool" >/dev/null 2>&1 || fail "Werkzeug fehlt: $tool"
done


# Verbindung NIE als URL in argv (Prozess-Listing): DATABASE_URL einmal zerlegen und ausschliesslich
# per Umgebung (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, ggf. PGSSLMODE) an pg_dump geben.
# Rohe "/", "?", "#" (und "@") in Benutzer/Passwort muessen prozent-kodiert sein (%2F, %3F, %23, %40).
url_decode() { printf '%b' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')"; }
URL_HINT="Sonderzeichen in Benutzer/Passwort prozent-kodieren (/ = %2F, ? = %3F, # = %23, @ = %40)"
[[ "$DATABASE_URL" =~ ^postgres(ql)?://(.*)$ ]] || fail "DATABASE_URL ist keine postgresql://-URL"
URL_REST="${BASH_REMATCH[2]}"
# Autoritaet = bis zum ersten "/", "?" oder "#".
URL_AUTH="${URL_REST%%[/?#]*}"
URL_AFTER_AUTH="${URL_REST#"$URL_AUTH"}"
# Steht danach noch ein "@", enthielt die Userinfo ein rohes "/", "?" oder "#" -> nicht eindeutig zerlegbar.
[[ "$URL_AFTER_AUTH" != *@* ]] || fail "DATABASE_URL nicht zerlegbar: $URL_HINT"
URL_USERINFO=""
URL_HOSTPORT="$URL_AUTH"
if [[ "$URL_AUTH" == *@* ]]; then
  URL_USERINFO="${URL_AUTH%@*}"
  URL_HOSTPORT="${URL_AUTH##*@}"
fi
URL_PORT=""
if [[ "$URL_HOSTPORT" =~ ^\[([^]]+)\](:([0-9]*))?$ ]]; then
  URL_HOST="${BASH_REMATCH[1]}"; URL_PORT="${BASH_REMATCH[3]}"
elif [[ "$URL_HOSTPORT" =~ ^([^:]*)(:([0-9]*))?$ ]]; then
  URL_HOST="${BASH_REMATCH[1]}"; URL_PORT="${BASH_REMATCH[3]}"
else
  fail "DATABASE_URL nicht zerlegbar (Host/Port): $URL_HINT"
fi
URL_PATH="${URL_AFTER_AUTH%%[?#]*}"
URL_QUERY=""
case "$URL_AFTER_AUTH" in *\?*) URL_QUERY="${URL_AFTER_AUTH#*\?}"; URL_QUERY="${URL_QUERY%%#*}" ;; esac
URL_DB="${URL_PATH#/}"
[[ "$URL_DB" != */* ]] || fail "DATABASE_URL nicht zerlegbar (Datenbankname): $URL_HINT"
unset PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE
[ -z "$URL_HOST" ] || export PGHOST="$(url_decode "$URL_HOST")"
[ -z "$URL_PORT" ] || export PGPORT="$URL_PORT"
[ -z "$URL_DB" ] || export PGDATABASE="$(url_decode "$URL_DB")"
if [ -n "$URL_USERINFO" ]; then
  if [[ "$URL_USERINFO" == *:* ]]; then
    export PGUSER="$(url_decode "${URL_USERINFO%%:*}")"
    export PGPASSWORD="$(url_decode "${URL_USERINFO#*:}")"
  else
    export PGUSER="$(url_decode "$URL_USERINFO")"
  fi
fi
# Query: sslmode und host (Unix-Socket) uebernehmen; schema (Prisma) und Rest ignorieren.
if [ -n "$URL_QUERY" ]; then
  IFS='&' read -r -a URL_PARAMS <<< "$URL_QUERY"
  for kv in "${URL_PARAMS[@]}"; do
    case "$kv" in
      sslmode=*) export PGSSLMODE="$(url_decode "${kv#sslmode=}")" ;;
      host=*) export PGHOST="$(url_decode "${kv#host=}")" ;;
      schema=* | "") ;;
      *) echo "Hinweis: URL-Parameter ignoriert: ${kv%%=*}" >&2 ;;
    esac
  done
fi
PG_ENV_NAMES=(PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE)
BACKUP_DIR="${BACKUP_DIR:-./backups}"
ATT_DIR="${ATTACHMENTS_DIR:-./data/attachments}"
ARC_DIR="${ARCHIVE_DIR:-./data/archive}"
ENV_FILE="${ENV_FILE:-./.env}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="oig-backup-${STAMP}.tar.enc"
mkdir -p "$BACKUP_DIR"
WORK="$(mktemp -d)"
STAGE="$WORK/stage"
mkdir -p "$STAGE"

# ------------------------------------------------------------------ Inhalt
if [ -n "$PG_DUMP_CONTAINER" ]; then
  # "-e NAME" ohne Wert: docker uebernimmt den Wert aus der Umgebung, nicht aus argv.
  DOCKER_ENV=()
  for n in "${PG_ENV_NAMES[@]}"; do [ -z "${!n:-}" ] || DOCKER_ENV+=(-e "$n"); done
  docker exec -i "${DOCKER_ENV[@]}" "$PG_DUMP_CONTAINER" pg_dump --no-owner --no-privileges | gzip > "$STAGE/db.sql.gz"
else
  pg_dump --no-owner --no-privileges | gzip > "$STAGE/db.sql.gz"
fi
[ -d "$ATT_DIR" ] || mkdir -p "$WORK/empty-att"
tar -czf "$STAGE/attachments.tar.gz" -C "$([ -d "$ATT_DIR" ] && echo "$ATT_DIR" || echo "$WORK/empty-att")" .
[ -d "$ARC_DIR" ] || mkdir -p "$WORK/empty-arc"
tar -czf "$STAGE/archive.tar.gz" -C "$([ -d "$ARC_DIR" ] && echo "$ARC_DIR" || echo "$WORK/empty-arc")" .
if [ -f "$ENV_FILE" ]; then cp "$ENV_FILE" "$STAGE/env.copy"; chmod 600 "$STAGE/env.copy"; fi

# Manifest aus dem Dump selbst (derselbe Snapshot): Zeilen der COPY-Bloecke je Tabelle.
MANIFEST_COUNTS="$(gunzip -c "$STAGE/db.sql.gz" | awk '
    BEGIN { n = split("Invoice Payment ChangeLog ArchivedDocument Dunning", names, " "); for (i = 1; i <= n; i++) count[names[i]] = 0 }
    /^COPY / { t = $2; sub(/^public\./, "", t); gsub(/"/, "", t); if (t in count) { cur = t; seen[t] = 1 } else cur = ""; next }
    /^\\\.$/ { cur = ""; next }
    cur != "" { count[cur]++ }
    END {
      for (i = 1; i <= n; i++) if (!(names[i] in seen)) { print "Tabelle fehlt im Dump: " names[i] > "/dev/stderr"; exit 3 }
      for (i = 1; i <= n; i++) print names[i] "=" count[names[i]]
    }')" || fail "erwartete Tabelle fehlt im Dump (Manifest nicht erstellbar)"
{ echo "created=$(now_iso)"; echo "$MANIFEST_COUNTS"; } > "$STAGE/manifest.txt"

tar -cf "$WORK/payload.tar" -C "$STAGE" .
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASS_FILE" -in "$WORK/payload.tar" -out "$BACKUP_DIR/$NAME"
chmod 600 "$BACKUP_DIR/$NAME"

# ----------------------------------------------------------- Offsite-Ziel
rotate_remote_by_listing() { # $1 = Listing-Befehl (Namen je Zeile), $2 = Loesch-Befehl-Praefix
  local cutoff n listing
  listing="$($1)" || fail "Listing der entfernten Sicherungen fehlgeschlagen"
  cutoff="oig-backup-$(cutoff_stamp "$KEEP_REMOTE").tar.enc"
  while IFS= read -r n; do
    case "$n" in
      oig-backup-*.tar.enc) if [[ "$n" < "$cutoff" ]]; then $2 "$n"; fi ;;
    esac
  done <<< "$listing"
  return 0
}

if [ -n "$TARGET" ]; then
  case "$TARGET" in
    rsync:*)
      SPEC="${TARGET#rsync:}"
      RHOST="${SPEC%%:*}"
      RPATH="${SPEC#*:}"
      [ -n "$RHOST" ] && [ "$RHOST" != "$SPEC" ] || fail "BACKUP_TARGET rsync: erwartet user@host:/pfad"
      command -v rsync >/dev/null 2>&1 || fail "Werkzeug fehlt: rsync"
      rsync -e ssh "$BACKUP_DIR/$NAME" "$RHOST:$RPATH/" || fail "rsync fehlgeschlagen"
      ssh "$RHOST" "find '$RPATH' -name 'oig-backup-*.tar.enc' -mtime +$KEEP_REMOTE -delete" \
        || echo "WARNUNG entfernte Rotation fehlgeschlagen" >&2
      ;;
    s3:*)
      DEST="${TARGET#s3:}"
      DEST="${DEST%/}"
      if command -v aws >/dev/null 2>&1; then
        aws s3 cp "$BACKUP_DIR/$NAME" "s3://$DEST/$NAME" >/dev/null || fail "aws s3 cp fehlgeschlagen"
        s3_list() { aws s3 ls "s3://$DEST/" | awk '{print $4}'; }
        s3_del() { aws s3 rm "s3://$DEST/$1" >/dev/null; }
      elif command -v rclone >/dev/null 2>&1; then
        rclone copyto "$BACKUP_DIR/$NAME" ":s3:$DEST/$NAME" || fail "rclone copyto fehlgeschlagen"
        s3_list() { rclone lsf ":s3:$DEST/"; }
        s3_del() { rclone deletefile ":s3:$DEST/$1"; }
      else
        fail "kein S3-Werkzeug (aws oder rclone erforderlich)"
      fi
      rotate_remote_by_listing s3_list s3_del
      ;;
  esac
fi

# ---------------------------------------------------------- lokale Rotation
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/oig-backup-*.tar.enc 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | while IFS= read -r old; do rm -f "$old"; done

trap - ERR
write_status "OK $(now_iso)"
echo "OK $BACKUP_DIR/$NAME"
