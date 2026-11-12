#!/bin/sh
# Startet die Anwendung im Container. Datenbankpruefung und Migrationen liegen in
# db-prepare.sh, damit sie ohne Anwendungsstart testbar sind.
set -eu

# Der Container laeuft als Benutzer "node" (UID 1000). Volumes aus Images vor 1.0.1
# (Container lief als root) gehoeren noch root — dann scheitert jedes Ablegen von
# Anhaengen und Archivdateien. Lieber gar nicht starten als Belege still nicht archivieren.
for dir in "${ATTACHMENTS_DIR:-/app/data/attachments}" "${ARCHIVE_DIR:-/app/data/archive}"; do
  mkdir -p "$dir" 2>/dev/null || true
  if [ ! -w "$dir" ] || [ -n "$(find "$dir" ! -user "$(id -u)" -print -quit 2>/dev/null)" ]; then
    cat >&2 <<MELDUNG
FEHLER: $dir ist fuer den Benutzer $(id -un) (UID $(id -u)) nicht beschreibbar.
Volumes aelterer Versionen gehoeren root. Einmalig umstellen, z. B.:

  docker compose run --rm --user root --cap-add CHOWN --cap-add DAC_READ_SEARCH --entrypoint chown app -R node:node /app/data

Danach startet der Container normal.
MELDUNG
    exit 1
  fi
done

sh ./scripts/db-prepare.sh
exec node server.js
