# Betrieb: Sicherung und Restore-Test (Vorlage)

Diese Datei ist eine **Vorlage im Repository**. Sie beschreibt, was der Betreiber auf dem Server
selbst einrichten muss. Die Skripte unter `scripts/ops/` enthalten keine Zugangsdaten; die
Serverkonfiguration (Volume, Cron, Offsite-Ziel, Passphrase) liegt nicht im Repository.

## Health-Check

- `GET /api/health` (ohne Anmeldung): `200 {"status":"ok"}` oder `503 {"status":"error"}`, nie zwischengespeichert,
  60 Aufrufe je Client-IP und Minute (Aufrufe ohne Client-IP-Header, etwa der Docker-Healthcheck, teilen sich einen eigenen Bucket mit 600 Aufrufen je Minute); die Datenbankabfrage hat ein Timeout von 2 s (dann 503). Geeignet fuer Monitoring und den Docker-Healthcheck.
- `GET /api/v1/System/health` (API-Schluessel mit Scope `admin`): Datenbank, letzter erfolgreicher Lauf je
  Scheduler-Job, freier Platz und Anzahl nicht archivierter Belege im Belegarchiv, letzte Hash-Ketten-Pruefung,
  letzte erfolgreiche Sicherung (aus `BACKUP_STATUS_FILE`).

## Was auf dem Server anzupassen ist

1. **Belegarchiv-Volume**: `docker-compose.yml` bindet `oig-archive:/app/data/archive` ein und setzt
   `ARCHIVE_DIR=/app/data/archive`. Auf einer bestehenden Installation die Compose-Datei uebernehmen
   (bzw. Volume und Variable ergaenzen) und den Container neu erstellen. Ohne Volume geht das Archiv beim
   Neuaufbau des Containers verloren.
2. **Passphrase-Datei**: z. B. `/etc/oig/backup.pass`, Modus 600, nur Root. Die Passphrase zusaetzlich
   **getrennt vom Server** verwahren (Passwortmanager, Tresor). Ohne sie ist keine Sicherung lesbar.
3. **Offsite-Ziel `BACKUP_TARGET`**: `rsync:user@host:/pfad` (SSH-Schluessel ohne Passwort, nur Schreibrechte
   fuer dieses Verzeichnis) oder `s3:bucket/prefix` (`aws` oder `rclone` installiert und konfiguriert).
   **Offen: Ziel und Verwahrung der Passphrase legt der Betreiber fest.** Ohne Ziel bleibt die Sicherung nur lokal.
4. **Variablen** (siehe `.env.example`): `BACKUP_PASSPHRASE_FILE`, `BACKUP_TARGET`, `BACKUP_KEEP_LOCAL=30`,
   `BACKUP_KEEP_REMOTE=90`, `BACKUP_STATUS_FILE`. Ausserdem `DATABASE_URL`, `ATTACHMENTS_DIR`, `ARCHIVE_DIR`
   (Pfade des Hosts bzw. der gemounteten Volumes) und optional `BACKUP_DIR`, `ENV_FILE`.
5. **Werkzeuge auf dem Host**: `pg_dump` (passend zur Serverversion), `tar`, `openssl`, `gzip`,
   `rsync` bzw. `aws`/`rclone`. Fuer den Restore-Test zusaetzlich `docker`, `node`/`npx`, `sha256sum`.
6. **Cron**:

       15 2 * * * cd /opt/open-invoice-germany && set -a && . ./.env && set +a && scripts/ops/backup.sh >> /var/log/oig-backup.log 2>&1
       30 3 1 * * cd /opt/open-invoice-germany && BACKUP_PASSPHRASE_FILE=/etc/oig/backup.pass scripts/ops/restore-test.sh "$(ls -1t backups/oig-backup-*.tar.enc | head -n1)" >> /var/log/oig-restore-test.log 2>&1

   Nach dem ersten Lauf pruefen: letzte Log-Zeile `OK <datei>`, Statusdatei enthaelt `OK <ISO>`.

## Sicherung (`scripts/ops/backup.sh`)

Erzeugt `oig-backup-<UTC>.tar.enc` (AES-256-CBC, PBKDF2) mit: PostgreSQL-Dump, Beleganhaenge, Belegarchiv,
Kopie der `.env` (enthaelt Geheimnisse, daher nur verschluesselt ablegen) und `manifest.txt` (Zeilenzahlen von
Invoice, Payment, ChangeLog, ArchivedDocument, Dunning). Das Manifest wird aus den COPY-Bloecken des Dumps selbst
ermittelt (derselbe Snapshot, keine Abweichung durch parallele Buchungen). Der Dump entsteht mit `--no-owner --no-privileges`
(Rollen der Produktion existieren im Restore-Container nicht); das Passwort aus `DATABASE_URL` wird per `PGPASSWORD`
uebergeben, nie als Argument, und der Prisma-Parameter `schema` fuer libpq entfernt. Dateien entstehen mit `umask 077`. Bricht ab, wenn die Passphrasen-Datei nicht Modus 600 hat.
Letzte Ausgabezeile `OK <datei>` bzw. `FEHLER <grund>`. Rotation lokal nach Anzahl, am Ziel nach Alter.
Schlaegt der Upload oder das Listing der entfernten Sicherungen fehl, endet der Lauf mit `FEHLER` (Exit 1); die lokale Sicherung bleibt erhalten. Nur das Loeschen einzelner alter Dateien am Ziel wird als Warnung gemeldet.

## Restore-Test (`scripts/ops/restore-test.sh <datei>`)

Entschluesselt, startet einen temporaeren `postgres:16`-Container, spielt den Dump ein und prueft:
`prisma migrate status`, Zeilenzahlen gegen das Manifest, Hash-Kette (`scripts/verify-chain.ts`) und fuenf
zufaellige Archivdateien per `sha256sum` gegen die Datenbank. Der Container wird in jedem Fall entfernt.
Monatlich ausfuehren; eine Sicherung gilt erst nach einem erfolgreichen Restore-Test als belegt.
Hinweis: `verify-chain.ts` nutzt den zur Laufzeit generierten Prisma-Client; der Test laeuft daher in einer
Umgebung, in der der Postgres-Client generiert ist (z. B. im App-Container oder nach
`npx prisma generate --schema=prisma/schema.postgres.prisma`).
