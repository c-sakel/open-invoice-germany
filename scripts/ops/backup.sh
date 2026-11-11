#!/usr/bin/env bash
# Verschluesselte Sicherung (Phase 16a, Vorlage): Datenbank, Beleganhaenge, Belegarchiv, .env, Manifest.
# Aufruf aus dem Projektverzeichnis (siehe docs/BETRIEB-VORLAGE.md). Konfiguration per Umgebung
# bzw. .env — KEINE Zugangsdaten in diesem Skript.
#
#   DATABASE_URL            PostgreSQL-URL (Pflicht)
#   ATTACHMENTS_DIR         Default ./data/attachments
#   ARCHIVE_DIR             Default ./data/archive
#   ENV_FILE                Default ./.env (wird mitgesichert, falls vorhanden)
#   BACKUP_DIR              lokales Zielverzeichnis, Default ./backups
#   BACKUP_PASSPHRASE_FILE  Datei mit der Passphrase (Pflicht, Modus 600)
#   BACKUP_TARGET           optional: rsync:user@host:/pfad | s3:bucket/prefix
#   BACKUP_KEEP_LOCAL       Anzahl lokaler Sicherungen (Default 30)
#   BACKUP_KEEP_REMOTE      Aufbewahrung am Ziel in Tagen (Default 90)
#   BACKUP_STATUS_FILE      optional: Statusdatei, je Lauf eine Zeile "OK <ISO>" bzw. "FEHLER <ISO> <grund>"
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
for tool in pg_dump tar openssl gzip; do
  command -v "$tool" >/dev/null 2>&1 || fail "Werkzeug fehlt: $tool"
done


# Passwort nie in argv (Prozess-Listing): aus der URL herausloesen und per PGPASSWORD uebergeben.
PG_URL="$DATABASE_URL"
[[ "$DATABASE_URL" =~ ^postgres(ql)?://(.*)$ ]] || fail "DATABASE_URL ist keine postgresql://-URL"
URL_REST="${BASH_REMATCH[2]}"
URL_AUTH="${URL_REST%%/*}"
URL_PREFIX="${DATABASE_URL%"$URL_REST"}"
if [[ "$URL_AUTH" == *@* ]]; then
  # Trennung am LETZTEN "@" der Autoritaet (ein rohes "@" im Passwort bleibt Teil des Passworts).
  URL_USERINFO="${URL_AUTH%@*}"
  URL_AFTER="${URL_REST#"$URL_USERINFO"@}"
  [ -n "$URL_AFTER" ] || fail "DATABASE_URL nicht zerlegbar"
  if [[ "$URL_USERINFO" == *:* ]]; then
    URL_USER="${URL_USERINFO%%:*}"
    URL_PASS="${URL_USERINFO#*:}"
    PG_URL="${URL_PREFIX}${URL_USER}@${URL_AFTER}"
    PGPASSWORD="$(printf '%b' "$(printf '%s' "$URL_PASS" | sed 's/\\/\\\\/g; s/%\([0-9A-Fa-f][0-9A-Fa-f]\)/\\x\1/g')")"
    export PGPASSWORD
  fi
fi
# Sicherheitsnetz: bleibt ein Passwort (user:pass@) in der URL, nie an pg_dump uebergeben.
PG_AUTH="${PG_URL#*://}"
PG_AUTH="${PG_AUTH%%/*}"
case "$PG_AUTH" in *:*@*) fail "DATABASE_URL nicht zerlegbar (Passwort verbleibt in der URL)" ;; esac
# libpq kennt den Prisma-Parameter "schema" nicht — entfernen.
PG_URL="$(printf '%s' "$PG_URL" | sed -E 's/([?&])schema=[^&]*&?/\1/; s/[?&]$//')"
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
pg_dump --no-owner --no-privileges "$PG_URL" | gzip > "$STAGE/db.sql.gz"
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
