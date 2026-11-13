# Betrieb: Sicherung und Restore-Test (Vorlage)

Diese Datei ist eine **Vorlage im Repository**. Sie beschreibt, was der Betreiber auf dem Server
selbst einrichten muss. Die Skripte unter `scripts/ops/` enthalten keine Zugangsdaten; die
Serverkonfiguration (Volume, Cron, Offsite-Ziel, Passphrase) liegt nicht im Repository.

## Health-Check

- `GET /api/health` (ohne Anmeldung): `200 {"status":"ok"}` oder `503 {"status":"error"}`. Kein Rate-Limit; das
  Datenbank-Ergebnis wird serverseitig 5 s zwischengespeichert (die Datenbank wird hoechstens alle 5 s gefragt,
  gleichzeitige Aufrufe teilen eine Abfrage; der Status kann daher bis zu 5 s alt sein). Die Antwort selbst traegt
  `Cache-Control: no-store`. Die Datenbankabfrage hat ein Timeout von 2 s (dann 503). Geeignet fuer Monitoring und den Docker-Healthcheck.
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
5. **Werkzeuge auf dem Host**: `pg_dump` (passend zur Serverversion; alternativ `PG_DUMP_CONTAINER=<db-container>`,
   dann laeuft `pg_dump` im Datenbank-Container mit dessen Version, die Verbindungsdaten nur per Umgebung), `tar`, `openssl`, `gzip`,
   `rsync` bzw. `aws`/`rclone`. Fuer den Restore-Test zusaetzlich `docker`, `node`/`npx`, `sha256sum` sowie einen fuer PostgreSQL generierten Prisma-Client (`npx prisma generate --schema prisma/schema.postgres.prisma`); `pg_dump` darf nicht neuer sein als der Restore-Container (`PG_IMAGE`, Default `postgres:16` = Serverversion; sonst scheitert das Einspielen an `transaction_timeout`).
6. **Cron**:

       15 2 * * * cd /opt/open-invoice-germany && set -a && . ./.env && set +a && scripts/ops/backup.sh >> /var/log/oig-backup.log 2>&1
       30 3 1 * * cd /opt/open-invoice-germany && BACKUP_PASSPHRASE_FILE=/etc/oig/backup.pass scripts/ops/restore-test.sh "$(ls -1t backups/oig-backup-*.tar.enc | head -n1)" >> /var/log/oig-restore-test.log 2>&1

   Nach dem ersten Lauf pruefen: letzte Log-Zeile `OK <datei>`, Statusdatei enthaelt `OK <ISO>`.
7. **Erster Deploy mit Belegarchiv (Backfill)**: Bestandsrechnungen und -mahnungen werden vom Scheduler-Job
   `archive` nachtraeglich archiviert (Quelle `BACKFILL`), je Lauf hoechstens `ARCHIVE_JOB_BATCH` Belege
   (Default 50, Lauf alle 15 min; bei ~1400 Belegen also rund 7 h). Gerendert wird im Web-Prozess; fuer weniger
   Lastspitzen `ARCHIVE_JOB_BATCH` kleiner setzen und den Deploy abends einplanen. Vorher einen Probelauf auf einer
   per Restore-Test eingespielten Produktionskopie machen (Laufzeit je Beleg, Fehler). Der erste Prueferexport ist
   erst nach Abschluss des Backfills sinnvoll: solange im Zeitraum mehr als 200 Belege ausstehen, lehnt der Export
   mit 409 ab (Einstellungen → Pruefung zeigt den Stand „ausstehend“).
8. **Container-Benutzer (ab 1.0.1)**: Die App laeuft als `node` (UID 1000). Beim ersten Deploy von 1.0.1 die
   App stoppen, die Volumes `oig-attachments` und `oig-archive` einmalig auf `1000:1000` umstellen, dann
   starten (laeuft der alte root-Container weiter, legt er neue root-eigene Dateien an). Nach einem Restore
   gilt dasselbe: zurueckgespielte Archiv- und Anhangdateien muessen UID 1000 gehoeren, sonst startet der
   Container nicht. Eine eingebundene `BACKUP_STATUS_FILE` muss fuer UID 1000 lesbar sein.

## Sicherung (`scripts/ops/backup.sh`)

Erzeugt `oig-backup-<UTC>.tar.enc` (AES-256-CBC, PBKDF2) mit: PostgreSQL-Dump, Beleganhaenge, Belegarchiv,
Kopie der `.env` (enthaelt Geheimnisse, daher nur verschluesselt ablegen) und `manifest.txt` (Zeilenzahlen von
Invoice, Payment, ChangeLog, ArchivedDocument, Dunning). Das Manifest wird aus den COPY-Bloecken des Dumps selbst
ermittelt (derselbe Snapshot, keine Abweichung durch parallele Buchungen). Der Dump entsteht mit `--no-owner --no-privileges`
(Rollen der Produktion existieren im Restore-Container nicht). `pg_dump` bekommt **keine URL** in argv: `DATABASE_URL`
wird einmal zerlegt und nur per Umgebung (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, ggf. `PGSSLMODE`)
uebergeben; der Prisma-Parameter `schema` entfaellt. Sonderzeichen in Benutzer/Passwort muessen prozent-kodiert sein
(`/` = `%2F`, `?` = `%3F`, `#` = `%23`, `@` = `%40`); ein rohes `/`, `?` oder `#` bricht mit `FEHLER` ab. Dateien entstehen mit `umask 077`. Bricht ab, wenn die Passphrasen-Datei nicht Modus 600 hat.
Letzte Ausgabezeile `OK <datei>` bzw. `FEHLER <grund>`. Rotation lokal nach Anzahl, am Ziel nach Alter.
Schlaegt der Upload oder das Listing der entfernten Sicherungen fehl, endet der Lauf mit `FEHLER` (Exit 1); die lokale Sicherung bleibt erhalten. Nur das Loeschen einzelner alter Dateien am Ziel wird als Warnung gemeldet.

## Restore-Test (`scripts/ops/restore-test.sh <datei>`)

Entschluesselt, startet einen temporaeren PostgreSQL-Container (`PG_IMAGE`, Default `postgres:16`), wartet, bis
`select 1` ueber TCP dreimal in Folge gelingt (das Image startet waehrend der Initialisierung einmal neu;
Timeout `RESTORE_READY_TIMEOUT`, Default 60 s), spielt den Dump ein und prueft:
`prisma migrate status`, Zeilenzahlen gegen das Manifest, Hash-Kette (`scripts/verify-chain.ts`) und fuenf
zufaellige Archivdateien per `sha256sum` gegen die Datenbank. Der Container wird in jedem Fall entfernt.
Monatlich ausfuehren; eine Sicherung gilt erst nach einem erfolgreichen Restore-Test als belegt.
Hinweis: `verify-chain.ts` nutzt den zur Laufzeit generierten Prisma-Client; der Test laeuft daher in einer
Umgebung, in der der Postgres-Client generiert ist (z. B. im App-Container oder nach
`npx prisma generate --schema=prisma/schema.postgres.prisma`).

## Notfallzugang: Zwei-Faktor abschalten (`scripts/disable-2fa.sh`)

Sind Authenticator-Gerät **und** Wiederherstellungscodes verloren, schaltet der Server-Zugang die Zwei-Faktor-Anmeldung ab:

    docker compose exec app sh ./scripts/disable-2fa.sh --bestaetigen --email admin@example.com

- `--bestaetigen` ist Pflicht, sonst Exit 2 und keine Änderung. Ohne `--email` werden **alle** Konten zurückgesetzt; ein leeres `--email ""` ist ein Fehler.
- Eine gültige, aber unbekannte Adresse endet mit Exit 1 („Kein Konto gefunden“), es wird nichts geändert.
- Das Skript löscht TOTP-Geheimnis und Wiederherstellungscodes, hebt eine Kontosperre auf, beendet alle bestehenden Sitzungen und entwertet offene Reset-Links. Das Passwort bleibt unverändert; danach unter „Einstellungen → Konto“ 2FA neu einrichten.
- Es entsteht **kein** Eintrag im Aktivitätsprotokoll. Wer Server-Zugang hat, hat ohnehin Vollzugriff auf die Datenbank.
- Die `DATABASE_URL` (mit Passwort) steht für die Laufzeit des Skripts in der Prozessliste des Containers.
- Passwort-Reset per Mail setzt SMTP (Einstellungen → E-Mail) und `APP_BASE_URL` voraus. Hinter einem Reverse-Proxy muss `X-Forwarded-For` gesetzt sein, sonst teilen sich alle Clients einen IP-Zähler (siehe LIMITATIONEN).
