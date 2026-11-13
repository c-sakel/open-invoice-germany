#!/bin/sh
# Notfallzugang (Phase 17d): schaltet die Zwei-Faktor-Anmeldung per Server-Zugang ab, loescht die
# Wiederherstellungscodes und hebt eine Kontosperre auf. Gedacht fuer den Fall, dass Geraet UND
# Wiederherstellungscodes verloren sind.
#
# Aufruf (DATABASE_URL gesetzt, SQLite "file:..." oder Postgres):
#   sh scripts/disable-2fa.sh --bestaetigen [--email <adresse>]
# Im Container:
#   docker compose exec app sh ./scripts/disable-2fa.sh --bestaetigen
# Ohne --email werden ALLE Konten zurueckgesetzt (Single-User-Betrieb).
#
# Folgen: kein Passwort wird geaendert, aber alle bestehenden Sitzungen enden (passwordChangedAt); die Anmeldung geht danach wieder allein mit dem Passwort.
# Es entsteht bewusst KEIN Eintrag im Aktivitaetsprotokoll: wer Server-Zugang hat, hat
# Vollzugriff auf die Datenbank (siehe BETRIEB-VORLAGE.md). Das SQL ist fuer SQLite und
# Postgres identisch.

set -eu

usage() {
  cat >&2 <<'MELDUNG'
Aufruf: sh scripts/disable-2fa.sh --bestaetigen [--email <adresse>]
  --bestaetigen   Pflicht; ohne sie wird nichts geaendert.
  --email <adr>   Nur dieses Konto (Standard: alle Konten).
DATABASE_URL muss gesetzt sein.
MELDUNG
  exit 2
}

CONFIRMED=0
EMAIL=""
EMAIL_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bestaetigen) CONFIRMED=1; shift ;;
    --email)
      [ $# -ge 2 ] || usage
      EMAIL="$2"
      EMAIL_GIVEN=1
      shift 2
      ;;
    *) usage ;;
  esac
done

[ "$CONFIRMED" = 1 ] || usage
[ -n "${DATABASE_URL:-}" ] || { echo "FEHLER: DATABASE_URL ist nicht gesetzt." >&2; usage; }

WHERE=""
TARGET="alle Konten"
# Eine angegebene, aber leere Adresse ist ein Fehler (sonst wuerden ALLE Konten getroffen).
if [ "$EMAIL_GIVEN" = 1 ]; then
  # Zeichenklasse VOR jedem SQL-Kontakt: kein Hochkomma, Zeilenumbruch oder Semikolon.
  case "$EMAIL" in
    *[!A-Za-z0-9._%+@-]*|*@*@*|@*|*@) usage ;;
    *@*) ;;
    *) usage ;;
  esac
  WHERE="WHERE \"email\" = '$EMAIL'"
  TARGET="$EMAIL"
fi

# passwordChangedAt = jetzt: beendet alle bestehenden Sitzungen (Token-pwc passt nicht mehr).
# Zeitstempel je Datenbank: SQLite speichert DateTime als Unix-Millisekunden, Postgres als UTC-Zeit.
case "$DATABASE_URL" in
  file:*) NOW_SQL="CAST(strftime('%s','now') AS INTEGER) * 1000" ;;
  *) NOW_SQL="(NOW() AT TIME ZONE 'UTC')" ;;
esac

if ! out=$(npx prisma db execute --url "$DATABASE_URL" --stdin 2>&1 <<SQL
UPDATE "PasswordResetToken" SET "usedAt" = $NOW_SQL WHERE "usedAt" IS NULL AND "userId" IN (SELECT "id" FROM "User" $WHERE);
DELETE FROM "RecoveryCode" WHERE "userId" IN (SELECT "id" FROM "User" $WHERE);
UPDATE "User" SET "totpSecretEnc" = NULL, "totpEnabledAt" = NULL, "totpLastStep" = NULL, "failedLoginCount" = 0, "lockedUntil" = NULL, "passwordChangedAt" = $NOW_SQL $WHERE;
SQL
); then
  printf '%s\n' "$out" >&2
  echo "FEHLER: Die Datenbank konnte nicht aktualisiert werden." >&2
  exit 1
fi

echo "Zwei-Faktor-Anmeldung abgeschaltet und Sperre aufgehoben fuer: $TARGET. Wiederherstellungscodes geloescht. Nach der Anmeldung unter Einstellungen -> Konto neu einrichten."
