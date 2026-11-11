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

[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL ist nicht gesetzt"
for tool in pg_dump psql tar openssl gzip; do
  command -v "$tool" >/dev/null 2>&1 || fail "Werkzeug fehlt: $tool"
done

KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-30}"
KEEP_REMOTE="${BACKUP_KEEP_REMOTE:-90}"
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
pg_dump "$DATABASE_URL" | gzip > "$STAGE/db.sql.gz"
[ -d "$ATT_DIR" ] || mkdir -p "$WORK/empty-att"
tar -czf "$STAGE/attachments.tar.gz" -C "$([ -d "$ATT_DIR" ] && echo "$ATT_DIR" || echo "$WORK/empty-att")" .
[ -d "$ARC_DIR" ] || mkdir -p "$WORK/empty-arc"
tar -czf "$STAGE/archive.tar.gz" -C "$([ -d "$ARC_DIR" ] && echo "$ARC_DIR" || echo "$WORK/empty-arc")" .
if [ -f "$ENV_FILE" ]; then cp "$ENV_FILE" "$STAGE/env.copy"; chmod 600 "$STAGE/env.copy"; fi

{
  echo "created=$(now_iso)"
  for t in Invoice Payment ChangeLog ArchivedDocument Dunning; do
    n="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"$t\"")"
    echo "$t=$n"
  done
} > "$STAGE/manifest.txt"

tar -cf "$WORK/payload.tar" -C "$STAGE" .
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASS_FILE" -in "$WORK/payload.tar" -out "$BACKUP_DIR/$NAME"
chmod 600 "$BACKUP_DIR/$NAME"

# ----------------------------------------------------------- Offsite-Ziel
rotate_remote_by_listing() { # $1 = Listing-Befehl (Namen je Zeile), $2 = Loesch-Befehl-Praefix
  local cutoff n
  cutoff="oig-backup-$(cutoff_stamp "$KEEP_REMOTE").tar.enc"
  while IFS= read -r n; do
    case "$n" in
      oig-backup-*.tar.enc) if [[ "$n" < "$cutoff" ]]; then $2 "$n"; fi ;;
    esac
  done < <($1)
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
      rotate_remote_by_listing s3_list s3_del || echo "WARNUNG entfernte Rotation fehlgeschlagen" >&2
      ;;
  esac
fi

# ---------------------------------------------------------- lokale Rotation
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/oig-backup-*.tar.enc 2>/dev/null | tail -n +"$((KEEP_LOCAL + 1))" | while IFS= read -r old; do rm -f "$old"; done

trap - ERR
write_status "OK $(now_iso)"
echo "OK $BACKUP_DIR/$NAME"
