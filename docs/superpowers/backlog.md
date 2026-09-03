# Backlog — OpenInvoice Germany (Fork c-sakel)

> **Abgelöst am 2026-09-02:** Das Lastenheft unter
> `docs/superpowers/requirements/2026-09-02-lastenheft-auftragsverwaltung.md`
> ist die maßgebliche Anforderung und gibt neun Umsetzungsphasen vor. Die
> Paketierung A–H unten bleibt als Übersicht stehen, die Reihenfolge gilt nicht mehr.

Stand: 2026-09-02. Quelle: Anforderungen des Betreibers, `docs/LIMITATIONEN.md` des
Upstream-Projekts, Architekturdokument (`docs/ARCHITEKTUR.md`, Stufen 2/3).

Jedes Paket durchläuft eigenständig: Brainstorming → Spec → Plan → Umsetzung mit
Review. Reihenfolge unten ist die empfohlene; Abhängigkeiten stehen je Paket.

Status: ☐ offen · ◐ in Arbeit · ☑ fertig

---

## Erledigt / in Arbeit

- ☑ **Postgres-Migrationen statt `db push`** — Branch `fix/postgres-migrations`,
  9 Commits, alle Tasks reviewt. Abschluss-Review über den Gesamtbranch noch
  ausstehend (vom Betreiber unterbrochen), vor dem Push nachholen.
- ☑ **Basic-Auth vor `/setup` entfernt** (Server-Ops, 2026-09-02). Admin-Konto
  existiert, die App sperrt `/setup` selbst.
- ◐ **Docker-Build reparieren** — Branch `fix/dockerfile-build` fertig, PR wartet
  auf Freigabe.
- ☑ **Phase 0 — Beleg-Snapshots + interne Notizen** — in `main` (2026-09-03), 7 Commits,
  Abschluss-Review + Fix-Welle durch. **Deployt 2026-09-03 06:43** (Baseline `0_init` verbucht,
  Phase-0-Migrationen + Backfill angewendet, 2 Belege eingefroren, Backup 06:42).

## Folgepunkte aus den Reviews (Migrations-Branch + Phase 0)

- ☐ **Mahnungs-PDF snapshotten** (`dunnings/[id]/pdf` liest live, braucht Dunning-Schema) → Phase 1
- ☐ **Stiller Snapshot-Fallback** bei defektem JSON: nur `console.warn` — ChangeLog-Eintrag/UI-Signal
- ☐ **`internalNotes` bearbeiten** — kein Edit-Pfad, kommt mit dem Entwurfs-Editor (Phase 4)
- ☐ **Drift-Warnung nach `migrate deploy`** (nicht-fatales `migrate diff --exit-code`) in `db-prepare.sh`
- ☐ **`Invoice.number` global `@unique`** statt je `orgId`; `documents/[id]/pdf` ohne `orgId`-Scope → Multi-Tenant
- ☐ **`canonicalize` nutzt `localeCompare`** statt Codepoint-Vergleich (Hash-Chain-Portabilität)
- ☐ **`docker-compose.yml` (Upstream)**: auskommentierter Mustang-Block referenziert `einvoice-service/`, existiert nicht
- ☐ **Postgres-Test**: Umlaut-Inhalt hart prüfen (heute nur Schlüsselzahl)
- ☐ **Repo-Dockerfile ohne `openssl`** — Prisma warnt im Container (`failed to detect the libssl/openssl version`); das fruehere Inline-Dockerfile hatte `apt-get install openssl`. In den Docker-Build-PR aufnehmen.
- ☐ **ARCHITEKTUR.md §2** straffen (historische Tabelle + Umgesetzt-Absatz lesen sich als Flickenteppich)

---

## A — Mailversand *(operativer Bedarf, Priorität 1)*

Die App verschickt heute keinerlei Mails. Ziel: Belege direkt aus der App versenden.

- ☐ **A1 SMTP-Konfiguration in den Einstellungen** — Host, Port, TLS-Modus,
  Benutzer, Passwort (verschlüsselt abgelegt), Absenderadresse/-name; Testversand-Button.
- ☐ **A2 Standardtexte je Belegart** — Rechnung, Storno/Gutschrift, Auftrag/AB,
  Angebot, Mahnung, Proforma. Betreff + Text mit Platzhaltern (Kunde, Belegnummer,
  Betrag, Fälligkeit, Firma). Beim Versand auswählbar und editierbar.
- ☐ **A3 CC/BCC** — Default-Werte in den Einstellungen, je Versand überschreibbar.
- ☐ **A4 Versand pro Beleg mit Anhängen** — PDF, XRechnung-XML, ZUGFeRD-Hybrid;
  Versandprotokoll (`EmailLog`: wann, an wen, welcher Beleg, Ergebnis) — GoBD-relevant.

Abhängigkeiten: A1, A2, A3 → A4. Schemaänderungen: ja (Postgres-Migrationen ✓).
Offen: Das Architekturdokument des Upstreams sieht **Resend** + React-Email vor,
wir bauen **SMTP** (DSGVO, Self-Hosting). Für den Fork entschieden; für einen
Upstream-PR vorher Issue stellen — sonst Risiko, dass er an der Richtung scheitert.

## B — Rechnungslayout & GiroCode *(Priorität 2)*

Vorlage: `RE-41276.pdf` (DIN 5008). Struktur: Logo rechts oben · Absenderzeile
klein über dem Adressfenster · Empfänger links · Meta-Block rechts (Rechnungs-Nr.,
Rechnungsdatum, Lieferdatum, Kundennummer, Ansprechpartner) · Titel · Positions-
tabelle (Pos., Beschreibung, Menge, Einzelpreis, Gesamtpreis) · Summenblock
(netto, USt, brutto fett) · **GiroCode links unter der Tabelle** · vierspaltige
Fußzeile (Firma/Adresse · Tel/E-Mail/Web · USt-ID/Steuer-Nr./Inhaber · Bank/IBAN/BIC)
· Seitenzahl „1/1".

- ☐ **B1 Rechnungs-PDF nach dieser Vorlage** — `src/lib/pdf/invoice-pdf.ts` (pdfkit)
  neu aufbauen. Firmendaten aus `Organization` (legalName, Adresse, Tel, E-Mail,
  Web, USt-ID, Steuer-Nr., IBAN, BIC, logoPath sind vorhanden).
- ☐ **B2 GiroCode (EPC-QR)** — aus IBAN, BIC, Empfänger, Betrag, Verwendungszweck
  (Rechnungsnummer). QR-Bibliothek nötig. Nur bei hinterlegter IBAN.
- ☐ **B3 Layout auf die übrigen Belege übertragen** — Storno/Gutschrift, Angebot,
  AB, Proforma, Mahnung (`dunning-pdf.ts`).

Abhängigkeiten: B2 und B3 bauen auf B1. Weitgehend unabhängig von A.

## C — Branding / White-Label *(klein)*

- ☐ **C1 App-Name und App-Logo in den Einstellungen änderbar** — UI-Header,
  Login-Seite, Seitentitel. (Nicht zu verwechseln mit dem Firmenlogo auf der
  Rechnung — das ist `Organization.logoPath` und existiert.)
- ☐ **C2 Favicon hochladbar.**

Braucht eine Dateiablage für Uploads (Logo, Favicon) — mit A4 (Anhänge) und B1
(Firmenlogo) abstimmen, damit nicht drei Ablagen entstehen.

## D — Konten & Sicherheit

- ☐ **D1 Login absichern** — Rate-Limiting/Brute-Force-Schutz, Passwort ändern
  (heute unmöglich ohne DB-Eingriff), Sitzungen beenden.
- ☐ **D2 Passwort-Reset per Mail** — braucht A.
- ☐ **D3 2FA (TOTP).**
- ☐ **D4 Mehrbenutzer/Rollen, Multi-Tenant mit Postgres-RLS** — eigenes Großprojekt.

## E — Mahnwesen & Abos

- ☐ **E1 Basiszins-Halbjahrestabelle pflegbar** (§ 288 BGB; heute hartkodiert 1,27 %).
- ☐ **E2 Eingebauter Scheduler** — Abo-Läufe ohne externen Cron; später auch
  Mail-Queue/Retry für A4.
- ☐ **E3 Nutzungsbasierte Abo-Abrechnung** — Verbrauchsmengen je Periode erfassen
  und abrechnen. Baut konzeptionell auf E2.

## F — E-Rechnung-Feinschliff *(aus LIMITATIONEN, fachlich tief)*

- ☐ **F1 Leitweg-ID / EAS-Schemacodes** (B2G, BT-10).
- ☐ **F2 PaymentMeans immer ausgeben; Positions-Rabatte BG-27/28; Skonto BT-20.**
- ☐ **F3 Striktes PDF/A-3** für ZUGFeRD (pdf-lib erzwingt es nicht).

Jede Änderung mit Quelle (Norm/KoSIT) und Update an `COMPLIANCE.md`.

## G — Auswertungen & Export

- ☐ **G1 DATEV-CSV-Export** (Buchungsstapel-Format; Formatspezifikation nötig).
- ☐ **G2 OSS (§ 18j) / ZM (§ 18a).**
- ☐ **G3 USt-Voranmeldungs-Auswertung.**
- ☐ **G4 VIES-Prüfung** der USt-IdNr.

## H — Daten & Recht, Rest

- ☐ **H1 Nummernkreis-UI** — Präfix/Muster/jahresunabhängig. GoBD-kritisch
  (Lückenlosigkeit), sehr sauber testen.
- ☐ **H2 Prüfziffern** IBAN/BIC/USt-IdNr. — IBAN ist Upstream-PR #2, nicht doppeln.

---

## Empfohlene Reihenfolge

1. **A Mailversand** — operativer Bedarf, von niemandem sonst angefasst
2. **B Layout + GiroCode** — konkrete Vorlage liegt vor, hoher sichtbarer Nutzen
3. **C Branding** — klein, Dateiablage gemeinsam mit A/B entwerfen
4. **D1 Login absichern** — inkl. Passwort ändern
5. **E2 Scheduler** — schaltet E3 und Mail-Retry frei
6. **G1 DATEV** — Formatspezifikation vorab beschaffen
7. E1, E3, H1, H2, F, G2–G4, D2–D4

## Aus dem Abschluss-Review Phase 1 (2026-09-03)

- **DunningStage.documentTemplateId ohne Ziel** — kein FK, kein Modell. In Phase 6 auf `TextTemplate`
  verknuepfen oder Feld entfernen (Migration additiv/rueckwaertskompatibel).
- **SQLite-Integrationstest ohne Mahnung** — `phase1.test.ts` prueft Backfill-Block 4 (stageId) nicht;
  nur Postgres-Fall 6 deckt ihn. Bei Phase-6-Arbeit eine Mahnung in die Test-Org legen.
- **Selbstheilung in payment.ts bei jedem Fehlversuch** — zwoelf Upserts in der Zahlungs-Tx vor dem
  Fehler. Optional: nur ausloesen, wenn die Org gar keine PaymentMethod-Zeile hat (Phase 4).
- **Gemischte ID-Formate** (`rel_*`, `pm_*`, `ds_*` aus Backfill neben cuids) — dauerhaft, dokumentiert;
  ID-Form nie als Herkunftsmerkmal verwenden.
- **createDeliveryNote parst Input nicht mit Zod** — heute kein Boundary. Phase 3 muss
  `createDeliveryNoteSchema` an Route/Action/MCP anwenden.
- **Auswahllisten Zahlungsmethoden/Mahnstufen** (Phase 4/6) muessen leere Listen vertragen; nie auf
  „genau 8/4 Eintraege" bauen.
- **Testkopplung** — `phase1.test.ts` fuehrt Migrations-SQL gegen die geteilte test.db aus und legt
  Stammdaten fuer alle Orgs anderer Testdateien an. Harmlos, aber Reihenfolgen-abhaengig.
- **untdidCode an PaymentMethod** wird bis Phase 4 von nichts gelesen; XRechnung/CII schreiben
  PaymentMeansCode hart 58. Phase 4 verdrahtet es (Lastenheft 12, 52).

## Aus Phase 2 (Mail, 2026-09-03)

- **scripts/migrate-postgres.sh fragt interaktiv** bei Prisma-Warnungen (z. B. neuer Unique-Index). Fuer CI/Subagenten: Bestaetigung automatisieren oder --create-only + deploy. (Phase 2 Task 1)
- **Mail: Zustell-/Bounce-Status** — SMTP liefert keine Rueckmeldung; DELIVERED/BOUNCED reserviert. Optional spaeter: Provider mit Webhook
  (Resend/SES) hinter dem `MailProvider`-Interface (`src/lib/mail/provider.ts`). Lastenheft 21/22.
- **Mail: HTML-Variante** — Phase 2 sendet Text/plain. Lastenheft verlangt es nicht; Nutzerwunsch moeglich.
- **Mail: Hintergrund-Queue** — Versand laeuft synchron in der Route (SMTP-Timeout 20 s). Scheduler-Phase (6) kann QUEUED-Logs abarbeiten.
- **Mail: Lieferschein-Versand** — Button erst mit Lieferschein-PDF (Phase 3); `buildStandardAttachments` liefert fuer DELIVERY_NOTE `[]`.
- **Mail: Einstellungsseite reicht das ganze describeMailSettings-Objekt an die Client-Form** (keine Geheimnisse, aber breite Props) — bei
  naechster Aenderung auf `MailSettingsFormData` zuschneiden.
- **Mail: MCP-Tool `send_document_email`** (Lastenheft 55) — eigene Phase; Domain `sendDocumentEmail` ist bereit, gleiche Validierung.
- **Invoice.number global unique** (bekannt) zwingt jede Testdatei in ein eigenes Jahr (2026 gobd, 2028 phase1, 2029 email-context, 2030 email).
- **proxy.ts-Matcher** (vorbestehend) schliesst alle Pfade mit Bildendung aus — `/api/emails/<id>.png` umgeht die Middleware
  (praktisch folgenlos, 404). Ausschluss auf `_next/`-Pfade begrenzen; eigener kleiner PR-Kandidat fuer Upstream.
- **Prisma ohne select** in templates-Actions, pickTemplate, emailLog-Reads — bei naechster Aenderung nachziehen.
- **Routen-Tests fuer /api/emails/*** — nur Content-Length-Test vorhanden (Fix-Welle); MIME-Whitelist, payload-Parsing, 404/409-Mapping ungetestet.
- **MIME-Whitelist vertraut dem Client-Typ** (`f.type`); echte Magic-Byte-Pruefung optional.
- **Mahnungs-Mails ohne Historie** — EmailHistory steht nur fuer den Rechnungs-docType auf der Rechnungsseite; DUNNING-Logs je Mahnung
  anzeigen (Phase 6 Mahnuebersicht).
