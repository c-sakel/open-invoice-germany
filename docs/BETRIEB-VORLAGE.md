# Betrieb: Sicherung und Restore-Test (Vorlage)

Diese Datei ist eine **Vorlage im Repository**. Sie beschreibt, was der Betreiber auf dem Server
selbst einrichten muss. Die Skripte unter `scripts/ops/` enthalten keine Zugangsdaten; die
Serverkonfiguration (Volume, Cron, Offsite-Ziel, Passphrase) liegt nicht im Repository.

## Health-Check

- `GET /api/health` (ohne Anmeldung): `200 {"status":"ok"}` oder `503 {"status":"error"}`. Kein Rate-Limit; das
  Datenbank-Ergebnis wird serverseitig 5 s zwischengespeichert (die Datenbank wird höchstens alle 5 s gefragt,
  gleichzeitige Aufrufe teilen eine Abfrage; der Status kann daher bis zu 5 s alt sein). Die Antwort selbst trägt
  `Cache-Control: no-store`. Die Datenbankabfrage hat ein Timeout von 2 s (dann 503). Geeignet für Monitoring und den Docker-Healthcheck.
- `GET /api/v1/System/health` (API-Schlüssel mit Scope `admin`): Datenbank, letzter erfolgreicher Lauf je
  Scheduler-Job, freier Platz und Anzahl nicht archivierter Belege im Belegarchiv, letzte Hash-Ketten-Prüfung,
  letzte erfolgreiche Sicherung (aus `BACKUP_STATUS_FILE`), freier Platz der Anhänge.

### Wächter

Bei jedem Lauf der Benachrichtigungen prüft das Programm und meldet als Pflicht-Benachrichtigung (auch per Alarm-Mail, je Typ und Tag einmal):
`SCHEDULER_STALE` (Aufgabe seit über 2 Stunden ohne erfolgreichen Lauf), `BACKUP_STALE` (letzte Sicherung älter als 36 Stunden, nur wenn
`BACKUP_STATUS_FILE` gesetzt ist) und `DISK_LOW` (weniger als 15 % Platz auf Belegarchiv oder Anhängen). Die Statusdatei enthält zeilenweise
`OK <ISO-Zeitstempel>`; die letzte passende Zeile zählt. Frisch gestartete Installationen melden nie gelaufene Aufgaben erst 2 Stunden nach dem Start.

- `GET /api/live` (ohne Anmeldung): `200 {"status":"ok"}`, ohne Datenbankzugriff, `Cache-Control: no-store`.
  Nur für die Liveness-Prüfung: Ein Datenbankausfall soll den Prozess nicht neu starten.

### Kubernetes-Probes

```yaml
startupProbe:
  httpGet: { path: /api/live, port: 3000 }
  periodSeconds: 5
  failureThreshold: 36   # bis zu 3 Minuten für Start und Migrationen
livenessProbe:
  httpGet: { path: /api/live, port: 3000 }
  periodSeconds: 20
  timeoutSeconds: 3
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /api/health, port: 3000 }
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

Der Docker-`HEALTHCHECK` im Image bleibt bei `/api/health`.

## Herunterfahren

Bei SIGTERM (Neustart, Node-Drain, `docker compose stop`) startet die Anwendung keine neue Hintergrundaufgabe mehr
und wartet bis zu 45 s, bis eine begonnene Aufgabe (z. B. ein automatischer Versand) zu Ende ist. Danach gibt sie
ihre Sperre frei und beendet sich mit Exitcode 0. Das Image setzt dafür `NEXT_MANUAL_SIG_HANDLE=true`.

- Kubernetes: `terminationGracePeriodSeconds: 60` (mindestens) im Pod setzen.
- Docker Compose: `stop_grace_period: 60s` (in der mitgelieferten `docker-compose.yml` gesetzt).

## Sicherheitsheader und Content-Security-Policy

- Alle Antworten tragen `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy` (Kamera, Mikrofon, Standort aus) und
  `Strict-Transport-Security: max-age=31536000` (ohne `includeSubDomains`, ohne `preload`).
- Seiten und `/api/docs` tragen zusätzlich eine Content-Security-Policy (der Proxy setzt sie bei jeder Antwort;
  Downloads unter `/api/...` behalten ihre eigene, strengere Policy). Die PDF-Vorschau (eigene Seite als Rahmen,
  `blob:`) und die Weiterleitung der Bezahlseite zum Zahlungsanbieter (`form-action 'self' https:`) sind erlaubt.
- `SECURITY_CSP` schaltet die Policy zur Laufzeit um, ohne neuen Build: `enforce` (Standard), `report-only`
  (Verstöße nur in der Browser-Konsole, nichts wird blockiert) oder `off`. Ein ungültiger Wert gilt als `enforce`
  und wird einmal im Log gemeldet. Notschalter bei unerwarteten Blockaden: `SECURITY_CSP=report-only` setzen und den
  Container neu starten.

## Was auf dem Server anzupassen ist

1. **Belegarchiv-Volume**: `docker-compose.yml` bindet `oig-archive:/app/data/archive` ein und setzt
   `ARCHIVE_DIR=/app/data/archive`. Auf einer bestehenden Installation die Compose-Datei übernehmen
   (bzw. Volume und Variable ergänzen) und den Container neu erstellen. Ohne Volume geht das Archiv beim
   Neuaufbau des Containers verloren.
2. **Passphrase-Datei**: z. B. `/etc/oig/backup.pass`, Modus 600, nur Root. Die Passphrase zusätzlich
   **getrennt vom Server** verwahren (Passwortmanager, Tresor). Ohne sie ist keine Sicherung lesbar.
3. **Offsite-Ziel `BACKUP_TARGET`**: `rsync:user@host:/pfad` (SSH-Schlüssel ohne Passwort, nur Schreibrechte
   für dieses Verzeichnis) oder `s3:bucket/prefix` (`aws` oder `rclone` installiert und konfiguriert).
   **Offen: Ziel und Verwahrung der Passphrase legt der Betreiber fest.** Ohne Ziel bleibt die Sicherung nur lokal.
4. **Variablen** (siehe `.env.example`): `BACKUP_PASSPHRASE_FILE`, `BACKUP_TARGET`, `BACKUP_KEEP_LOCAL=30`,
   `BACKUP_KEEP_REMOTE=90`, `BACKUP_STATUS_FILE`. Außerdem `DATABASE_URL`, `ATTACHMENTS_DIR`, `ARCHIVE_DIR`
   (Pfade des Hosts bzw. der gemounteten Volumes) und optional `BACKUP_DIR`, `ENV_FILE`.
5. **Werkzeuge auf dem Host**: `pg_dump` (passend zur Serverversion; alternativ `PG_DUMP_CONTAINER=<db-container>`,
   dann läuft `pg_dump` im Datenbank-Container mit dessen Version, die Verbindungsdaten nur per Umgebung), `tar`, `openssl`, `gzip`,
   `rsync` bzw. `aws`/`rclone`. Für den Restore-Test zusätzlich `docker`, `node`/`npx`, `sha256sum` sowie einen für PostgreSQL generierten Prisma-Client (`npx prisma generate --schema prisma/schema.postgres.prisma`); `pg_dump` darf nicht neuer sein als der Restore-Container (`PG_IMAGE`, Default `postgres:16` = Serverversion; sonst scheitert das Einspielen an `transaction_timeout`).
6. **Cron**:

       15 2 * * * cd /opt/open-invoice-germany && set -a && . ./.env && set +a && scripts/ops/backup.sh >> /var/log/oig-backup.log 2>&1
       30 3 1 * * cd /opt/open-invoice-germany && BACKUP_PASSPHRASE_FILE=/etc/oig/backup.pass scripts/ops/restore-test.sh "$(ls -1t backups/oig-backup-*.tar.enc | head -n1)" >> /var/log/oig-restore-test.log 2>&1

   Nach dem ersten Lauf prüfen: letzte Log-Zeile `OK <datei>`, Statusdatei enthält `OK <ISO>`.
7. **Erster Deploy mit Belegarchiv (Backfill)**: Bestandsrechnungen und -mahnungen werden vom Scheduler-Job
   `archive` nachträglich archiviert (Quelle `BACKFILL`), je Lauf höchstens `ARCHIVE_JOB_BATCH` Belege
   (Default 50, Lauf alle 15 min; bei ~1400 Belegen also rund 7 h). Gerendert wird im Web-Prozess; für weniger
   Lastspitzen `ARCHIVE_JOB_BATCH` kleiner setzen und den Deploy abends einplanen. Vorher einen Probelauf auf einer
   per Restore-Test eingespielten Produktionskopie machen (Laufzeit je Beleg, Fehler). Der erste Prüferexport ist
   erst nach Abschluss des Backfills sinnvoll: solange im Zeitraum mehr als 200 Belege ausstehen, lehnt der Export
   mit 409 ab (Einstellungen → Prüfung zeigt den Stand „ausstehend“).
8. **Container-Benutzer (ab 1.0.1)**: Die App läuft als `node` (UID 1000). Beim ersten Deploy von 1.0.1 die
   App stoppen, die Volumes `oig-attachments` und `oig-archive` einmalig auf `1000:1000` umstellen, dann
   starten (läuft der alte root-Container weiter, legt er neue root-eigene Dateien an). Nach einem Restore
   gilt dasselbe: zurückgespielte Archiv- und Anhangdateien müssen UID 1000 gehören, sonst startet der
   Container nicht. Eine eingebundene `BACKUP_STATUS_FILE` muss für UID 1000 lesbar sein.

## Sicherung (`scripts/ops/backup.sh`)

Erzeugt `oig-backup-<UTC>.tar.enc` (AES-256-CBC, PBKDF2) mit: PostgreSQL-Dump, Beleganhänge, Belegarchiv,
Kopie der `.env` (enthält Geheimnisse, daher nur verschlüsselt ablegen) und `manifest.txt` (Zeilenzahlen von
Invoice, Payment, ChangeLog, ArchivedDocument, Dunning). Das Manifest wird aus den COPY-Blöcken des Dumps selbst
ermittelt (derselbe Snapshot, keine Abweichung durch parallele Buchungen). Der Dump entsteht mit `--no-owner --no-privileges`
(Rollen der Produktion existieren im Restore-Container nicht). `pg_dump` bekommt **keine URL** in argv: `DATABASE_URL`
wird einmal zerlegt und nur per Umgebung (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, ggf. `PGSSLMODE`)
übergeben; der Prisma-Parameter `schema` entfällt. Sonderzeichen in Benutzer/Passwort müssen prozent-kodiert sein
(`/` = `%2F`, `?` = `%3F`, `#` = `%23`, `@` = `%40`); ein rohes `/`, `?` oder `#` bricht mit `FEHLER` ab. Dateien entstehen mit `umask 077`. Bricht ab, wenn die Passphrasen-Datei nicht Modus 600 hat.
Letzte Ausgabezeile `OK <datei>` bzw. `FEHLER <grund>`. Rotation lokal nach Anzahl, am Ziel nach Alter.
Schlägt der Upload oder das Listing der entfernten Sicherungen fehl, endet der Lauf mit `FEHLER` (Exit 1); die lokale Sicherung bleibt erhalten. Nur das Löschen einzelner alter Dateien am Ziel wird als Warnung gemeldet.

## Restore-Test (`scripts/ops/restore-test.sh <datei>`)

Entschlüsselt, startet einen temporären PostgreSQL-Container (`PG_IMAGE`, Default `postgres:16`), wartet, bis
`select 1` über TCP dreimal in Folge gelingt (das Image startet während der Initialisierung einmal neu;
Timeout `RESTORE_READY_TIMEOUT`, Default 60 s), spielt den Dump ein und prüft:
`prisma migrate status`, Zeilenzahlen gegen das Manifest, Hash-Kette (`scripts/verify-chain.ts`) und fünf
zufällige Archivdateien per `sha256sum` gegen die Datenbank. Der Container wird in jedem Fall entfernt.
Monatlich ausführen; eine Sicherung gilt erst nach einem erfolgreichen Restore-Test als belegt.
Hinweis: `verify-chain.ts` nutzt den zur Laufzeit generierten Prisma-Client; der Test läuft daher in einer
Umgebung, in der der Postgres-Client generiert ist (z. B. im App-Container oder nach
`npx prisma generate --schema=prisma/schema.postgres.prisma`).


## Postversand

1. **Notschalter `POSTAL_NETWORK=0`** (Umgebungsvariable, siehe `.env.example`): sperrt **jeden** Netzaufruf zum Briefdienst im Prozess, unabhängig von den Einstellungen. Trockenlauf, Protokoll und Oberfläche laufen weiter; Verbindungstest, Preisabfrage, Übertragung, Storno und Abgleich melden „Netzzugriff auf den Briefdienst ist gesperrt“. Leer oder jeder andere Wert = Netz erlaubt. In Tests und beim Smoke ist die Sperre immer aktiv.
2. **Zugangsdaten** trägt der Betreiber unter „Einstellungen → Postversand“ ein; sie liegen verschlüsselt in der Datenbank (Schlüssel per HKDF aus `AUTH_SECRET`, Zweck `oig-postal-key-v1`). Sie gehören in keine `.env` und in keinen Beleg, kein Protokoll und keine Meldung.
3. **Erste Inbetriebnahme:** Zugang eintragen (Schalter bleiben aus) und **einmal „Verbindung prüfen“** (nur `GET /v3/balance`, lesend). Erst dieser Test bestätigt, ob die Basis-URL `https://api.letterxpress.de/v3` per HTTPS erreichbar ist (die Dokumentation des Anbieters nennt nur `http`; das Programm nutzt nie HTTP).
4. **Schlüsselrotation:** Neuen API-Schlüssel beim Briefdienst erzeugen, in „Einstellungen → Postversand“ eintragen (ersetzt den alten, „Entfernen“ löscht ihn), danach den alten beim Anbieter sperren. Empfohlen, wenn der Schlüssel außerhalb des Programms übermittelt wurde.
5. **`AUTH_SECRET` wechseln** macht den gespeicherten Schlüssel unlesbar (Meldung „nicht lesbar“, kein Versand, Abgleich überspringt die Organisation). Danach den Schlüssel neu eintragen.
6. **Scheduler:** Der Job `postal` läuft nach `dunning` in der bestehenden Job-Reihenfolge (je Auftrag frühestens alle 15 Minuten ein Abgleich; mit eingebautem Scheduler oder `npm run scheduler:run`). Er ruft den Briefdienst nur bei eingeschaltetem Postversand im Modus Testmodus/Live mit gültigem Zugang auf.
7. **Sicherung:** Die Tabellen `PostalSettings`, `PostalJob`, `PostalJobEvent` sind im Datenbank-Dump enthalten. Das Versandprotokoll ist append-only und wird nicht gelöscht.

## Notfallzugang: Zwei-Faktor abschalten (`scripts/disable-2fa.sh`)

Sind Authenticator-Gerät **und** Wiederherstellungscodes verloren, schaltet der Server-Zugang die Zwei-Faktor-Anmeldung ab:

    docker compose exec app sh ./scripts/disable-2fa.sh --bestaetigen --email admin@example.com

- `--bestaetigen` ist Pflicht, sonst Exit 2 und keine Änderung. Ohne `--email` werden **alle** Konten zurückgesetzt; ein leeres `--email ""` ist ein Fehler.
- Eine gültige, aber unbekannte Adresse endet mit Exit 1 („Kein Konto gefunden“), es wird nichts geändert.
- Das Skript löscht TOTP-Geheimnis und Wiederherstellungscodes, hebt eine Kontosperre auf, beendet alle bestehenden Sitzungen und entwertet offene Reset-Links. Das Passwort bleibt unverändert; danach unter „Einstellungen → Konto“ 2FA neu einrichten.
- Es entsteht **kein** Eintrag im Aktivitätsprotokoll. Wer Server-Zugang hat, hat ohnehin Vollzugriff auf die Datenbank.
- Die `DATABASE_URL` (mit Passwort) steht für die Laufzeit des Skripts in der Prozessliste des Containers.
- Passwort-Reset per Mail setzt SMTP (Einstellungen → E-Mail) und `APP_BASE_URL` voraus.
- **Alarm-Mail:** Meldungen zu Pflicht-Alarmen und gescheiterten Abo-Versendungen gehen (wenn „Einstellungen → Benachrichtigungen → Alarme sofort per E-Mail“ an ist, Standard) an die Firmen-E-Mail-Adresse, höchstens einmal je Stunde. Dafür muss SMTP eingerichtet sein; fehlt die Firmenadresse, geht die Mail an die Absenderadresse. Die Mail nennt nur die Art der Meldung und die Anzahl; `APP_BASE_URL` liefert den Link zur Meldungsliste (ohne diese Variable entfällt die Link-Zeile).
- **Client-IP für die Bremsen (`CLIENT_IP_SOURCE`):** Hinter Cloudflare `CLIENT_IP_SOURCE=cf` setzen und den Origin per nginx (oder Firewall) nur für Cloudflare-IP-Bereiche erreichbar machen, sonst lässt sich `cf-connecting-ip` fälschen. Hinter nginx allein `CLIENT_IP_SOURCE=x-real-ip` und im Server-Block `proxy_set_header X-Real-IP $remote_addr;` (überschreibt statt anzuhängen). Mehrere Proxys in Reihe: `xff` mit `TRUSTED_PROXY_COUNT`. Ohne Einstellung gilt `legacy` (fälschbar, siehe LIMITATIONEN); fehlt der Header ganz, teilen sich alle Clients einen IP-Zähler.
- **Zugriffsprotokolle und Portal-Token:** Der Portal-Link (`/portal/<token>`, `/api/public/portal/<token>/…`) steht im Klartext im Pfad. Die Anwendung protokolliert ihn nie, nginx und CDN-Protokolle aber schon, samt IP. Für `location ^~ /portal/` und `location ^~ /api/public/portal/` daher `access_log off;` setzen (oder ein Logformat ohne `$request_uri`/`$request`). Bei Cloudflare die Anfrageprotokolle (Logpush, Logs) für diese Pfade ausnehmen bzw. nicht aufbewahren.
- **Zugriffsprotokolle und Bezahllinks:** Auch der Bezahllink (`/zahlen/<token>`) und die Webhook-Adresse der Online-Zahlung (`/api/public/payments/<anbieter>/<kennung>`) tragen ein Geheimnis im Pfad. Für `location ~ ^/(zahlen|api/public/payments)/` daher ebenfalls `access_log off;` setzen bzw. die Anfrageprotokolle des CDN für diese Pfade ausnehmen. Die Anwendung selbst protokolliert den Link nie. Der Pfad `/api/public/payments/stripe/<kennung>` fällt unter dieselbe Regel; ein eigener Block ist nicht nötig.
- **Stripe-Webhook: Body-Grenze und Uhrzeit:** Stripe-Benachrichtigungen sind bis 128 KiB groß (die Anwendung lehnt Größeres ab); `client_max_body_size` des Reverse-Proxys muss mindestens 128 KiB erlauben (nginx-Standard 1 MiB genügt). Die Signatur hat eine Toleranz von 5 Minuten: Die Serveruhr muss per NTP abgeglichen sein, sonst werden gültige Benachrichtigungen abgelehnt.

## Eingangsrechnungen: Prüfung und Ablage

1. **Prüfer im Image:** Das ausgelieferte Image enthält den KoSIT-Validator samt zugeschnittener Java-Laufzeit (`/opt/validator`, `/opt/jre`; Variablen `EINVOICE_VALIDATOR_DIR`, `EINVOICE_JAVA` sind im Image gesetzt, kein Eintrag in `.env` nötig). Die Prüfung läuft als eigener Prozess je Rechnung; es ist kein zusätzlicher Dienst und keine `VALIDATOR_URL` nötig.
2. **`INCOMING_VALIDATION=off`** (in `.env`) schaltet die Prüfung ab; neue Eingänge stehen dann auf „nicht geprüft“ (`ENGINE_OFF`). Ohne gesetzte Variable ist die Prüfung an. Wird der Prüfer nachträglich wieder bereitgestellt, bleiben bereits als „nicht geprüft“ abgelegte Belege bis zur manuellen Neuprüfung unverändert.
3. **Speicher:** Je Prüfung rund 400 MB Arbeitsspeicher zusätzlich (Java-Heap höchstens 384 MB, bei 5.000 Positionen insgesamt 340 bis 590 MB); Prüfungen laufen nacheinander, nie zwei gleichzeitig. Frist je Prüfung 60 Sekunden. Eine Speichergrenze des Containers muss diesen Mehrbedarf zulassen. Das Auslesen eines PDF braucht höchstens 192 MB Heap für den Worker.
4. **Netz:** Die Prüfung braucht keine ausgehende Netzverbindung; der Prüfer lädt zur Laufzeit nichts nach, und die Anwendung löst keine externen Verweise aus fremden Dateien auf. Die Artefakte werden nur beim Bau des Images geladen (siehe 5).
5. **Artefakte aktualisieren:** Neue Versionen des Validators oder der Konfiguration trägt man in `assets/einvoice-validation/pins.env` (URL und SHA-256) ein; das Skript `scripts/fetch-einvoice-validator.sh <Zielordner>` lädt sie, prüft die Summen und legt sie ab (Dockerfile-Stage und CI nutzen dasselbe Skript). Ohne Docker lokal: `scripts/fetch-einvoice-validator.sh validation/.cache/einvoice-validator` und `EINVOICE_JAVA` auf eine Java-Laufzeit ab Version 17 setzen.
6. **Ablage:** Eingangsrechnungen liegen unter `ARCHIVE_DIR/incoming/<Firma>/<Jahr>/` write-once und gehören zur Sicherung (Belegarchiv-Volume). Es gibt keine Löschfunktion; die wöchentliche Kettenprüfung vergleicht die Dateien mit ihren Hashes und meldet veränderte oder fehlende Dateien als `ARCHIVE_TAMPERED`.
7. **Nachlauf:** Der Archiv-Job holt Prüfungen nach, die nach der Annahme nicht abgeschlossen wurden (höchstens 5 je Lauf, ab 2 Minuten Alter).
8. **Reverse-Proxy:** `client_max_body_size` muss mindestens 21 MB erlauben (REST-Annahme Base64, Datei bis 15 MB), für den Upload der Oberfläche mindestens 16 MB.

## Eingangsrechnungen: Postfach-Abruf

Der Abruf eines Rechnungs-Postfachs ist ab Werk **aus** (Einstellungen → Rechnungs-Postfach). Wer ihn einschaltet, beachtet:

1. **Ausgehende Verbindung (Egress):** Die Anwendung verbindet sich nur zum eingetragenen IMAP-Server und nur auf Port **993** (TLS) oder **143** (STARTTLS). Firewall und Container-Netz müssen genau diesen Weg erlauben; andere Ports sind in der Anwendung gesperrt.
2. **Notschalter und Eingrenzung (`.env`):** `INBOUND_MAIL_NETWORK=0` sperrt jeden Verbindungsaufbau (Einstellungen und Daten bleiben). `INBOUND_MAIL_HOSTS` (Komma-Liste) beschränkt die erlaubten Server; ohne Eintrag ist jeder öffentliche Server zulässig. `INBOUND_MAIL_ALLOW_PRIVATE=1` erlaubt zusätzlich private Netzbereiche (z. B. ein Mailserver im eigenen Netz); Loopback, Link-Local und eingebettete Adressen bleiben gesperrt.
3. **Zertifikate:** Die Verbindung prüft das Serverzertifikat. Ein Server mit privater Zertifizierungsstelle braucht deren Zertifikat über `NODE_EXTRA_CA_CERTS` (Pfad zu einer PEM-Datei im Container).
4. **Zwischenablage und Sicherung:** Anlagen vor der Entscheidung liegen unter `ATTACHMENTS_DIR/mail-inbox/<Firma>/`; das Verzeichnis gehört zur Sicherung des Anhänge-Volumes (`oig-attachments`). Übernommene Dateien liegen im write-once-Belegarchiv (Abschnitt oben). Kontingent der Sichtung: 500 Anlagen oder 2 GB je Firma, danach pausiert der Abruf.
5. **Speicher:** Die Zerlegung einer Mail läuft in einem eigenen Prozess mit höchstens 256 MB Heap (15 Sekunden Frist).
6. **Scheduler:** Der Job `mailbox` läuft im Takt des Schedulers (`SCHEDULER_INTERVAL_MINUTES`, Standard 15) nach `archive`.
7. **Passwort:** Es liegt nur verschlüsselt in der Datenbank (Schlüssel aus `AUTH_SECRET`); wird `AUTH_SECRET` geändert, muss es neu eingegeben werden.

## Kontoabruf (FinTS)

Der Abruf von Bankumsätzen ist ab Werk **aus** (Einstellungen → Kontoabruf). Wer ihn einschaltet, beachtet:

1. **Produkt-ID:** Der Abruf braucht eine für diese Installation bei der Deutschen Kreditwirtschaft registrierte FinTS-Produkt-ID (fints.org, kostenlos). Sie wird nur in der Oberfläche eingetragen und steht nie im Repository oder Image.
2. **Ausgehende Verbindung (Egress):** `https` (Port 443) zur FinTS-Adresse der Bank. `FINTS_HOSTS` (Komma-Liste) beschränkt die erlaubten Server; leer erlaubt alle öffentlichen Hosts (private und lokale Adressbereiche bleiben gesperrt). `FINTS_NETWORK=0` sperrt jeden Verbindungsaufbau. Ein Server mit privater Zertifizierungsstelle braucht `NODE_EXTRA_CA_CERTS`.
3. **Ein Prozess:** Die Freigabe-Sitzung lebt im Arbeitsspeicher; der Container läuft als einzelne Instanz. Ein Neustart während einer Freigabe bricht sie ab.
4. **Scheduler:** Der Job `bank-fetch` läuft im Takt des Schedulers nach `mailbox`.
5. **PIN:** Sie liegt, wenn gespeichert, nur verschlüsselt in der Datenbank (Schlüssel aus `AUTH_SECRET`); wird `AUTH_SECRET` geändert, muss sie neu eingegeben werden. Die Sicherung bleibt unverändert (Datenbank).
