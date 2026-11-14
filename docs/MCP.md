# Rechnungen per Sprache erstellen — mit einem KI-Assistenten (MCP)

OpenInvoice Germany bringt einen **MCP-Server** mit. Damit verbindest du deine lokale Instanz mit einem **MCP-fähigen KI-Assistenten** und erstellst rechtssichere Rechnungen, indem du einfach **sagst, was du willst**.

> Die Tools setzen auf den GoBD-/EN-16931-gehärteten Kern auf: Das Festschreiben **erzwingt** die § 14-Pflichtangaben, festgeschriebene Rechnungen sind unveränderbar. Die KI kann also keine *nicht*-konforme Rechnung erzeugen.

## 🔒 Datenschutz (DSGVO) — bevor du echte Kundendaten nutzt

Der **Rechnungs-Kern von OpenInvoice läuft zu 100 % lokal** (deine Datenbank, dein Rechner). Das MCP-Feature ist **optional**.

Sobald du eine Rechnung von einem **Cloud-LLM** erstellen lässt, werden die Inhalte, die du beschreibst — Kundenname, Adresse, Leistungen, Beträge = **personenbezogene Daten** — an den LLM-Anbieter **übermittelt** und dort in deinem Auftrag verarbeitet (**Auftragsverarbeitung, Art. 28 DSGVO**). Der „lokal"-Charakter gilt also für die App, **nicht** automatisch für den KI-Pfad.

Für den geschäftlichen Einsatz mit echten Personendaten gibt es zwei saubere Wege:

| Weg | Datenfluss | DSGVO-Status |
|-----|-----------|--------------|
| **Lokales Modell** — den MCP-Server von einem MCP-Client betreiben lassen, der ein **lokales Modell** nutzt (z. B. via Ollama/LM Studio); MCP ist anbieterneutral | bleibt auf deinem Rechner | kein Drittanbieter, kein AVV nötig |
| **Cloud-LLM mit AVV** — z. B. ein **kommerzieller API-Zugang** mit DPA/AVV (kein Training auf deinen Daten, SCCs bei US-Transfer) | geht an den Anbieter | AVV vorhanden; Anbieter als Sub-Auftragsverarbeiter dokumentieren |

> ⚠️ Desktop- und Coding-Assistenten mit Cloud-Modell senden die Inhalte immer an den Anbieter. **Consumer-Abos haben in der Regel keinen AVV** und sind für fremde Personendaten nicht geeignet — nutze dann den **kommerziellen API-Zugang** des Anbieters. Für einen rein lokalen Datenfluss einen MCP-Client mit lokalem Modell wählen.

Nimm den genutzten LLM-Anbieter in dein **Verzeichnis von Verarbeitungstätigkeiten** und deine **Datenschutzerklärung** auf. Dies ist **keine Rechtsberatung**; rechtliche Grundlagen in [COMPLIANCE.md](../COMPLIANCE.md).

## 1. Einrichten

```bash
git clone https://github.com/c-sakel/open-invoice-germany.git
cd open-invoice-germany
npm install
cp .env.example .env
npm run db:migrate
```

Teste den Server kurz: `npm run mcp` (er meldet „MCP-Server bereit" auf stderr; mit Strg+C beenden).

### Im MCP-Client registrieren

Die meisten MCP-Clients lesen eine `.mcp.json` im Projekt (oder eine globale Konfiguration) — **absoluten Pfad** einsetzen:

```json
{
  "mcpServers": {
    "open-invoice-germany": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/ABSOLUTER/PFAD/zu/open-invoice-germany"
    }
  }
}
```

Im Client prüfen, dass `open-invoice-germany` verbunden ist. Desktop-Clients: denselben Block in deren MCP-Konfigurationsdatei eintragen.

Konto-Sicherheit (Zwei-Faktor-Anmeldung, Passwort-Reset) gibt es nur über die Sitzung der Weboberfläche; der MCP-Zugang mit API-Schlüssel bleibt davon unberührt.

## 2. So redest du mit ihm

> **„Richte mein Unternehmen ein: Müller Handwerk GmbH, Lindenstr. 5, 21337 Lüneburg, Steuernummer 33/123/45678, IBAN DE02 1203 0000 0000 2020 51."**

> **„Leg den Kunden ‚Sparkasse Lüneburg' an, Adresse An der Münze 4–6, 21335 Lüneburg, USt-IdNr. DE811…"**

> **„Speichere die Leistung ‚Beratung' zu 95 € pro Stunde."**

> **„Erstelle eine Rechnung an Müller über 3 Stunden Beratung, Leistung heute — und schreib sie fest."**

> **„Exportier die XRechnung und das PDF."**

> **„Leg einen monatlichen Wartungsvertrag für Müller über 99 € an, ab dem 1. des nächsten Monats, und schreib die Rechnungen automatisch fest."**

> **„Welche Abos sind fällig? Erzeuge die fälligen Rechnungen."**

Der Assistent ruft im Hintergrund die passenden Tools auf (`setup_company` → `upsert_customer` → `upsert_product` → `create_invoice` → `finalize_invoice` → `export_invoice`) und legt die Dateien unter `exports/` ab — inkl. EN-16931-Validierung. Weitere Beispiele wie im Lastenheft (§55) gefordert: siehe [ANLEITUNG.md](ANLEITUNG.md#7-per-sprache-mit-einem-ki-assistenten-mcp).

## 3. Verfügbare Tools

105 Tools, registriert in `src/mcp/server.ts` über 16 Bereichsmodule unter `src/mcp/tools/` (siehe [ARCHITEKTUR.md](ARCHITEKTUR.md) für die Modulstruktur). Alle Tools rufen dieselben Domain-Funktionen und Zod-Schemas wie UI/API auf — keine Bypass-Pfade (§55).

### System

| Tool | Zweck | Beispiel |
|---|---|---|
| `get_status` | Zustand der aktiven Organisation (Unternehmen eingerichtet? Kunden-/Produkt-/Rechnungszähler) | „Wie ist der Status meiner Instanz?" |
| `list_api_requests` | Protokollierte REST-API-Anfragen auflisten (Phase 12d) — Zeit, Methode, Pfad, Status, Dauer, Schlüssel; standardmäßig leer, bis „Einstellungen → API → Anfrageprotokoll" eingeschaltet ist | „Zeig mir die letzten fehlgeschlagenen API-Aufrufe." |
| `setup_company` | Eigene Stammdaten anlegen/ändern (§ 14-Pflichtangaben: Name, Anschrift, Steuernummer/USt-IdNr., IBAN; optional `sepaCreditorId`, die SEPA-Gläubiger-ID für Lastschriften (BT-90) — wird geprüft und normalisiert; ohne Angabe bleibt der Bestand, das **Leeren geht nur in der Oberfläche**) | „Richte mein Unternehmen ein: Müller Handwerk GmbH, Lindenstr. 5, 21337 Lüneburg, Steuernummer 33/123/45678." |
| `verify_audit_chain` | Hash-Kette des Änderungsprotokolls lückenlos prüfen, Prüfung protokollieren, bei Bruch alarmieren (Phase 16a) | „Prüfe die Hash-Kette des Änderungsprotokolls." |
| `create_audit_export` | Prüfer-Export nach § 147 Abs. 6 AO (ZIP: CSV-Tabellen, `index.xml`, DTD, Kettenprüfung, archivierte Belege PDF/XML) für einen Zeitraum von höchstens drei Jahren in `exports/` schreiben | „Erzeuge den Prüfer-Export für 2025." |
| `get_invoice_archive` | Archivstand einer Rechnung (PDF/CII/UBL mit SHA-256, Quelle, Zeitpunkt); archiviert nicht selbst | „Ist die Rechnung RE-50001 archiviert?" |
| `reverse_payment` | Zahlung per Gegenbuchung korrigieren (negative Zahlungszeile mit Begründung; Zahlungen werden nie gelöscht) | „Storniere die Zahlung vom 03.03. bei RE-50001, falsch gebucht." |

### Kunden

| Tool | Zweck | Beispiel |
|---|---|---|
| `list_customers` | Kunden auflisten. Abgleich: mit `updatedSince` (ISO 8601 mit Zone) kommen geänderte Datensätze aufsteigend nach `updatedAt`, `nextCursor` als `cursor` für die Folgeseite, `limit` 1 bis 200 (ohne `updatedSince` oder `cursor` wird `limit` abgelehnt), `includeArchived`; `sort`/`offset` sind im Abgleich nicht erlaubt | „Zeig mir alle Kunden." |
| `upsert_customer` | Kunde anlegen oder aktualisieren — Match per exaktem Namen (kein `id`-Parameter); gezieltes Ändern per ID: `update_customer`; beide nehmen die Mandatsfelder `sepaMandateReference`, `sepaMandateSignedAt`, `sepaDebitIban` und `sepaDebitAccountName` an (Referenz und IBAN nur zusammen; beide leer entfernt das Mandat) | „Leg den Kunden ‚Sparkasse Lüneburg' an, Adresse An der Münze 4–6, 21335 Lüneburg." |
| `update_customer` | Kunde gezielt per ID/Name patchen (anders als `upsert_customer` **kein** Anlegen; nur angegebene Felder ändern sich) | „Ändere bei Müller GmbH die E-Mail auf buchhaltung@mueller.de." |
| `archive_customer` | Kunde archivieren (verschwindet aus `list_customers`/Picker, bleibt in Beleg-Snapshots erhalten) | „Archiviere den Kunden Alt-Kunde GmbH." |
| `get_customer_overview` | Kunden-KPIs (offen/überfällig/Nettoumsatz/letzte Aktivität) eines einzelnen Kunden; der Block `customer` enthält Mandatsreferenz, Unterschriftsdatum und die **maskierte** IBAN (`sepaDebitIbanMasked`, z. B. `DE02 **** 2051`), nie die volle IBAN | „Wie ist der Kontostand von Müller GmbH?" |
| `list_customer_addresses` | Alle Adressen eines Kunden auflisten (Typ Rechnung/Lieferung/Sonstige, Standard-Kennzeichen) | „Welche Adressen hat Müller GmbH hinterlegt?" |
| `upsert_customer_address` | Adresse anlegen (`id` weglassen) oder ändern (`id` angeben); `isDefault: true` setzt sie zum Standard des Typs | „Leg für Müller GmbH eine Lieferadresse an: Hafenstr. 2, 21335 Lüneburg." |
| `delete_customer_address` | Adresse löschen (bestehende Beleg-Snapshots bleiben unverändert) | „Lösche die alte Lieferadresse von Müller GmbH." |
| `set_default_address` | Zusatzadresse als Default ihres Typs setzen (verdrängt den bisherigen Default) | „Setze die Hafenstraße als Standard-Lieferadresse von Müller GmbH." |
| `list_contact_persons` | Alle Ansprechpartner eines Kunden auflisten | „Wer sind die Ansprechpartner bei Müller GmbH?" |
| `upsert_contact_person` | Ansprechpartner anlegen (`id` weglassen) oder ändern (`id` angeben); `isDefault: true` setzt ihn zum kundenweiten Standard | „Leg Frau Meyer als Ansprechpartnerin bei Müller GmbH an." |
| `delete_contact_person` | Ansprechpartner löschen | „Lösche Herrn Schmidt als Ansprechpartner bei Müller GmbH." |
| `set_default_contact` | Ansprechpartner als kundenweiten Default setzen | „Setze Frau Meyer als Standard-Ansprechpartnerin bei Müller GmbH." |
| `check_vat_id` | USt-IdNr. eines Kunden qualifiziert über VIES (EU-Kommission) prüfen und protokollieren (`customerId`); übermittelt die Kunden- und die eigene USt-IdNr.; Dienstfehler ergeben einen Protokolleintrag mit Status `ERROR` | „Prüf die USt-IdNr. von Müller GmbH." |
| `list_vat_id_checks` | Prüfprotokoll der USt-IdNr. eines Kunden (neueste zuerst, max. 50) | „Zeig das Prüfprotokoll der USt-IdNr. von Müller GmbH." |
| `update_customer_defaults` | Die zehn Kundenvorgaben (Standardwährung, Standard-Rabatt, Rechnungs-/Angebots-E-Mail + CC, E-Rechnung bevorzugt, Bestellreferenz, Liefer-/Zahlungsbedingungstext, Sprache) als **Vollersatz** setzen — weggelassene Felder werden zurückgesetzt | „Setze bei Müller GmbH einen Standard-Rabatt von 5 % und XRechnung als bevorzugtes Format." |
| `list_custom_fields` | Organisationsweite Kundenfeld-Definitionen auflisten (Schlüssel, Typ, Pflicht, Reihenfolge) | „Welche eigenen Kundenfelder habe ich definiert?" |
| `upsert_custom_field` | Kundenfeld-Definition anlegen (`id` weglassen) oder ändern (`id` angeben); Schlüssel-Konflikt liefert Fehler | „Leg ein Kundenfeld ‚Kundennummer im alten System' vom Typ Text an." |
| `delete_custom_field` | Kundenfeld-Definition löschen (bereits gespeicherte Werte bleiben im JSON stehen, werden aber still ignoriert) | „Lösche das Kundenfeld ‚Fax-Nummer'." |
| `reorder_custom_fields` | Reihenfolge aller Kundenfeld-Definitionen neu setzen (`ids` muss genau die vorhandene Menge enthalten) | „Sortiere die Kundenfelder so, dass ‚Kundennummer im alten System' zuerst kommt." |
| `set_customer_custom_fields` | Kundenfeldwerte eines Kunden setzen — validiert strikt gegen die aktiven Definitionen (unbekannte Schlüssel werden abgelehnt) | „Setze bei Müller GmbH das Kundenfeld ‚Kundennummer im alten System' auf 4711." |

### Produkte

| Tool | Zweck | Beispiel |
|---|---|---|
| `list_products` | Leistungen/Produkte im Katalog auflisten. Abgleich: mit `updatedSince` (ISO 8601 mit Zone) kommen geänderte Datensätze aufsteigend nach `updatedAt`, `nextCursor` als `cursor` für die Folgeseite, `limit` 1 bis 200 (ohne `updatedSince` oder `cursor` wird `limit` abgelehnt), `includeArchived`; `sort`/`offset` sind im Abgleich nicht erlaubt | „Zeig mir alle gespeicherten Leistungen." |
| `upsert_product` | Produkt anlegen oder aktualisieren — Match per exaktem Namen (kein `id`-Parameter, inkl. §25a Differenzbesteuerung); gezieltes Ändern per ID: `update_product` | „Speichere die Leistung ‚Beratung' zu 95 € pro Stunde." |
| `update_product` | Produkt gezielt per ID/Name patchen (anders als `upsert_product` **kein** Anlegen) | „Ändere den Preis von ‚Beratung' auf 105 € pro Stunde." |
| `archive_product` | Produkt archivieren (verschwindet aus `list_products`/Picker, bleibt in Beleg-Snapshots erhalten) | „Archiviere die Leistung ‚Altprodukt'." |

### Wechselkurse (Phase 16b)

Kursquelle ist standardmäßig der amtliche Monatsdurchschnitt (`fxRateSource = BMF_MONTHLY`, § 16 Abs. 6 Satz 1 UStG); der EZB-Tageskurs (`ECB_DAILY`) nur mit Gestattung des Finanzamts (`update_document_settings`). Fehlt der Monatskurs, gilt der Vormonat (der Monat wird genannt). Das Monatsmittel entsteht nur bei mindestens 15 Tageskursen; Kurse über 2000 je EUR werden abgelehnt. `create_invoice` und `create_document` nehmen zusätzlich `language` (`de`/`en`, sonst Kundensprache) an; `create_invoice` auch `fxOverrideRate`; `create_delivery_note`, `create_recurring` und `update_recurring_invoice` nehmen `language` an, `update_invoice_draft` zusätzlich `fxOverrideRate`, `cancel_invoice` und `credit_invoice` `fxOverrideRate` (nur für Altbelege ohne Kurs). Die MCP-Tools laufen wie alle anderen ohne Scope-Modell (lokaler Admin-Zugang).

| Tool | Zweck | Beispiel |
|---|---|---|
| `get_exchange_rate` | Kurs für Währung und Stichtag gemäß Kursquelle abrufen | „Welcher Kurs gilt für USD am 12.11.2026?" |
| `set_exchange_rate` | Kurs pflegen (`source` `MONTHLY` mit Monatserstem oder `ECB`), überschreibt Importe | „Setze den Monatskurs USD für November 2026 auf 1,0850." |
| `refresh_exchange_rates` | EZB-Kurse sofort abrufen und Monatsmittel des Vormonats berechnen (bei `FX_AUTO_FETCH=0` abgeschaltet) | „Hol die aktuellen Wechselkurse." |

### Postversand (Phase 16d)

Rechnungen und Mahnungen lassen sich über einen Briefdienst drucken und versenden. Zugangsdaten und die Schalter (`enabled`, `mode`, `autoDunningPost`, Monatsbudget) sind **nur in der Oberfläche** änderbar; über MCP/REST ist der Schlüssel nie lesbar (nur `hasApiKey`/`apiKeyLast4`), der wirksame Modus dagegen schon. Ablauf: erst `get_postal_quote`, dem Nutzer Anschrift, Seiten und Preis zeigen, dann nur nach ausdrücklicher Zustimmung `send_by_post` mit `confirm: true`, `expectedPriceCents` und `pdfSha256` aus dem Angebot. Bei ausgeschaltetem Postversand entsteht nur ein Trockenlauf-Protokoll; im Modus `LIVE` ist der Versand kostenpflichtig. Die Tools nutzen dieselben Zod-Schemas wie REST (`/api/v1/PostalQuote`, `/api/v1/PostalJob`, `/api/v1/Settings/postal`); Auslöser `MCP`.

Die REST-Routen unterscheiden die Scopes `read` (Lesen), `write` (Angebot, Preis, Versand, Storno) und `admin` (Einstellungen, Verbindungstest, manueller Abschluss); die **MCP-Tools laufen ohne Scope-Modell** (lokaler Admin-Zugang), daher kann `resolve_postal_job` per MCP ohne `admin`-Scope aufgerufen werden — der Zugang selbst ist die Berechtigung. `send_by_post`, `cancel_postal_job` und `resolve_postal_job` verlangen `confirm: true` (REST: `send_by_post` und Storno ebenso; der manuelle Abschluss ist dort ein `admin`-Aufruf). `resolve_postal_job` mit `NOT_SENT` gibt den Neuversand frei und darf nur nach Prüfung durch den Nutzer im Kundenbereich des Briefdienstes aufgerufen werden; der Versand zählt auf dasselbe Kontingent (30 Aktionen/Minute und Organisation). Wiederholung desselben Versands ist über die Doppelversand-Sperre geschützt (`ALREADY_SENT`); `repeat: true` erlaubt einen weiteren Versand nur nach abgeschlossenem Brief, nie solange ein Auftrag des Belegs `PENDING`, `SUBMITTING` oder `UNKNOWN` ist (dann `ALREADY_SENT`, erst manuell abschließen); der `Idempotency-Key` gilt nur für REST.

| Tool | Zweck | Beispiel |
|---|---|---|
| `get_postal_settings` | Einstellungen und wirksamen Modus lesen (ohne Zugangsdaten) | „Ist der Postversand aktiv?" |
| `update_postal_print_options` | Nur Druckoptionen setzen (Farbe, Duplex, Versandart, Einschreiben-Vorgabe); Schalter/Zugangsdaten werden abgelehnt | „Drucke Briefe künftig doppelseitig." |
| `test_postal_connection` | Verbindung prüfen (nur Guthabenabfrage, kein Versand) | „Prüf die Verbindung zum Briefdienst." |
| `get_postal_price` | Preis eines Briefs abfragen (nur bei aktiviertem Postversand) | „Was kostet ein 2-seitiger Brief?" |
| `get_postal_quote` | Angebot je Beleg (Anschrift, Seiten, Preis, Prüfsumme, Probleme); versendet nichts | „Was würde der Versand von RE-50001 per Post kosten?" |
| `send_by_post` | Belege per Post senden bzw. Trockenlauf protokollieren (`confirm: true`, Preis und Prüfsumme aus dem Angebot; kostenpflichtig bei `LIVE`) | „Schick RE-50001 per Post." |
| `list_postal_jobs` | Postaufträge auflisten (Filter Status, Belegart, Beleg, Modus) | „Welche Briefe sind noch unterwegs?" |
| `get_postal_job` | Auftrag mit Ereignissen lesen | „Wo ist der Brief zu RE-50001?" |
| `cancel_postal_job` | Auftrag stornieren (nur binnen 15 Minuten, nur QUEUED/HOLD/DRAFT) | „Storniere den Brief." |
| `resolve_postal_job` | Auftrag mit unklarem Ausgang (UNKNOWN) nach Prüfung beim Briefdienst manuell abschließen (`SENT`/`NOT_SENT`, mit Begründung, `confirm: true`); auch ein Testauftrag nach Ablauf der Stornofrist (nur `NOT_SENT`) | „Der Brief wurde laut Briefdienst nicht versendet — schließ den Auftrag ab." |

### Angebote / Auftragsbestätigungen / Lieferscheine

| Tool | Zweck | Beispiel |
|---|---|---|
| `create_document` | Angebot / Auftragsbestätigung / Proforma anlegen (optional `currency`) | „Erstelle für Müller GmbH ein Angebot über 10 Stunden Beratung zu 95 Euro." |
| `list_documents` | Angebote/AB/Proformas auflisten (Filter u. a. Status, Kunde). Abgleich: mit `updatedSince` (ISO 8601 mit Zone) kommen geänderte Datensätze aufsteigend nach `updatedAt`, `nextCursor` als `cursor` für die Folgeseite, `limit` 1 bis 200 (ohne `updatedSince` oder `cursor` wird `limit` abgelehnt), `includeArchived`; `sort`/`offset` sind im Abgleich nicht erlaubt | „Welche Angebote sind noch offen?" |
| `get_quote` | Details eines Angebots/einer AB/Proforma anzeigen | „Zeig mir Angebot ANG-2026-00123." |
| `get_delivery_note` | Details eines Lieferscheins anzeigen | „Zeig mir Lieferschein LS-2026-00045." |
| `convert_document_to_invoice` | Dokument → Rechnungs-Entwurf | „Erstelle aus Angebot ANG-2026-00123 eine Rechnung." |
| `convert_document` | Generische Umwandlung: Angebot → AB, Angebot/AB/Proforma → Rechnung, Angebot/AB/Rechnung → Lieferschein (optional Teilmengen) | „Erzeuge aus Angebot ANG-2026-00123 eine Auftragsbestätigung." |
| `create_delivery_note` | Lieferschein ohne Quelldokument anlegen (Direktlieferung) | „Erstelle aus dem Auftrag einen Lieferschein." |
| `update_delivery_note` | Lieferschein-Entwurf (Status DRAFT) ändern: Kunde, Positionen, Lieferdatum und Versanddatum (jeweils leerer String leert es), Notizen, Sprache; `create_delivery_note` legt mit `draft: true` einen Entwurf an | „Ändere im Lieferschein-Entwurf die Menge der ersten Position.“ |
| `set_document_status` | Status eines Angebots/einer AB oder eines Lieferscheins setzen (MARK_SENT/MARK_ACCEPTED/MARK_REJECTED/MARK_CREATED/MARK_DELIVERED/CANCEL/ARCHIVE/UNARCHIVE) | „Markiere Angebot ANG-2026-00123 als angenommen." |
| `duplicate_document` | Angebot/AB/Proforma, Lieferschein oder Rechnung als neuen Entwurf duplizieren | „Dupliziere Angebot ANG-2026-00123 als neuen Entwurf." |
| `take_over_last_document` | Letzten passenden Vorgängerbeleg eines Kunden finden und daraus Positionen/Texte/Bedingungen/Preise als Vorschlag liefern (§32) | „Übernimm die Positionen aus dem letzten Angebot an Müller GmbH." |

### Rechnungen

| Tool | Zweck | Beispiel |
|---|---|---|
| `create_invoice` | Rechnung als Entwurf; mit `finalize: true` atomar angelegt und festgeschrieben (unveränderbar, Korrektur nur per Storno), optional mit `payment` (`amountEuro`, `paidAt`, `method`, `reference`; ohne Betrag der volle offene Betrag) — dann ist `idempotencyKey` Pflicht (gleicher Schlüssel + gleiche Argumente liefern dieselbe Antwort, nie zwei Rechnungen; anderer Inhalt = Konflikt), es wird nichts versendet (optional `currency`, ISO-Code; Kette Kunde > Einstellung > EUR; Kunde per Name, Positionen in €/Menge oder via gespeicherter Leistung; bei einer Kartenmethode (UNTDID `48`/`54`/`55`) optional `cardPanTruncated` — nur die letzten 4 Ziffern, mehr als 10 Ziffern werden abgelehnt —, `cardNetwork` und `cardHolderName`, bei anderen Methoden werden sie verworfen) | „Erstelle eine Rechnung an Müller über 3 Stunden Beratung, Leistung heute." |
| `finalize_invoice` | Festschreiben — prüft Pflichtangaben, vergibt Nummer, macht unveränderbar; nicht blockierende Hinweise (fehlende elektronische Adresse, VIES-Ergebnis bei ig. Lieferung) stehen im Antworttext (Phase 17a) | „Schreib die Rechnung fest." |
| `update_invoice_draft` | Rechnungsentwurf bearbeiten (nur `DRAFT`) — Kopffelder (Betreff, Bestellnummer BT-13, interne Referenz, Ansprechpartner, Rechnungs-/Lieferadresse) sowie Positionen inkl. `lineType`; die Kartenfelder `cardPanTruncated`, `cardNetwork`, `cardHolderName` wie bei `create_invoice` (ein Methodenwechsel auf Nicht-Karte leert sie); Rechnungstyp bleibt unveränderbar | „Setze bei der Entwurfsrechnung die Bestellnummer auf PO-4711." |
| `get_invoice` | Rechnung anzeigen, inkl. Zahlungen mit ID (für `reverse_payment`) | „Zeig mir Rechnung RE-2026-00342." |
| `list_invoices` | Auflisten mit Filter (Status inkl. wirksamem Status fällig/überfällig und `credit` (Gutschriften), Belegtyp, Kunde, Zeitraum, Betrag, Nummer, Zahlungsart, E-Rechnung, Währung, Freitextsuche, Paginierung); Abgleich mit `updatedSince`/`cursor` (Antwort mit `nextCursor`, ohne `sort`/`offset`) | „Welche Rechnungen sind überfällig?" |
| `export_invoice` | PDF + XRechnung + ZUGFeRD in Datei (`exports/`) + Validierungsreport | „Exportier die XRechnung und das PDF." |
| `credit_invoice` | Teilgutschrift / Teilerstattung (Original bleibt festgeschrieben); verrechnet sich mit dem offenen Rest (Zahlungsart `CREDIT_NOTE`, kein Geldeingang), Summe aller Gutschriften höchstens Rechnungsbetrag | „Erstelle eine Teilgutschrift über 50 Euro zu RE-2026-00342." |
| `cancel_invoice` | Storno-Gutschrift (Original bleibt erhalten); optional `reason` (Stornogrund, steht in den Belegnotizen), nach Teilgutschriften nur der Rest, Hinweis auf fällige Erstattung | „Storniere RE-2026-00342." |
| `cancel_invoices` | 1 bis 50 festgeschriebene Rechnungen (`invoices`: IDs oder Nummern, `reason` Pflicht) nacheinander stornieren; je Beleg eigene Storno-Gutschrift, Ergebnis je Beleg (`ok`/`failed`, Codes z. B. `NOT_CANCELLABLE`, `NOT_FOUND`), ein Fehler stoppt die übrigen nicht; kein Versand; höchstens 10 Aufrufe pro Minute | „Storniere RE-1001 und RE-1002 wegen Doppelerfassung." |

### Teil-/Abschlags-/Schlussrechnungen

| Tool | Zweck | Beispiel |
|---|---|---|
| `create_partial_invoice` | Teilrechnung aus einem Angebot/einer AB oder einem Lieferschein — Prozent, Netto-/Bruttobetrag, oder einzelne Positionen/Mengen | „Erstelle eine Teilrechnung über 30 Prozent aus Angebot ANG-2026-00123." |
| `create_downpayment_invoice` | Abschlagsrechnung vor Leistungserbringung (nur aus Angebot/AB) — löst § 13 Abs. 1 Nr. 1 Buchst. a Satz 4 UStG aus | „Erstelle eine Abschlagsrechnung über 30 Prozent." |
| `create_final_invoice` | Schlussrechnung über die Gesamtleistung — setzt mindestens eine festgeschriebene, nicht stornierte Abschlagsrechnung voraus; setzt die Abschläge samt Steuer automatisch ab (§ 14 Abs. 5 UStG) | „Erstelle die Schlussrechnung für den Auftrag von Müller GmbH." |
| `get_billing_state` | Abrechnungsstand eines Angebots/einer AB (NONE/PARTIAL/FULL, abgerechnetes Promille, Summe der Abschläge) | „Wie viel ist von Angebot ANG-2026-00123 schon abgerechnet?" |

### Zahlungen

| Tool | Zweck | Beispiel |
|---|---|---|
| `record_payment` | Zahlungseingang erfassen → Status (bezahlt/teilbezahlt) und Zahlungs-ID; optional `note` (Freitext) | „Buche auf RE-2026-00342 eine Zahlung von 500 Euro." |
| `list_payment_methods` | Zahlungsmethoden der Organisation auflisten (Code, Name, Zahlungsziel, aktiv/System) — nützlich für Codes bei `create_invoice`/`record_payment` | „Welche Zahlungsmethoden habe ich hinterlegt?" |

### Mahnwesen

| Tool | Zweck | Beispiel |
|---|---|---|
| `create_dunning` | Nächste fällige Mahnstufe erzeugen (Verzugszins § 288 BGB + Mahnkosten ab Stufe 2 + 40-€-Pauschale B2B, `force` überspringt die Fälligkeitsprüfung) | „Erstelle die nächste Mahnstufe." |
| `send_dunning` | Eine erstellte Mahnung per E-Mail versenden (dieselbe Mailpipeline wie Rechnungen/Angebote) | „Sende für RE-2026-00342 eine Zahlungserinnerung." |
| `set_dunning_state` | Mahnprozess einer Rechnung pausieren (mit Datum), beenden oder wieder aktivieren | „Pausiere den Mahnprozess für RE-2026-00342 bis Monatsende." |
| `list_overdue_invoices` | Mahnübersicht: alle überfälligen, offenen Rechnungen (Widgets + Zeilen, Fälligkeits-Aging), optional nach Mahnprozess-Status gefiltert | „Welche Rechnungen sind überfällig?" |
| `list_dunning_stages` | Konfigurierte Mahnstufen einer Organisation auflisten | „Zeig mir meine Mahnstufen." |
| `update_dunning_stage` | Eine Mahnstufe teilweise aktualisieren (`id` + Felder) — Merge mit dem aktuellen Stand | „Setze bei Mahnstufe 2 die Mahnkosten auf 8 Euro." |

### E-Mail

| Tool | Zweck | Beispiel |
|---|---|---|
| `send_email` | Beleg (Angebot/AB/Proforma, Rechnung/Gutschrift, Lieferschein, Mahnung) per E-Mail versenden — `docId` per Nummer oder ID, Betreff/Text/Empfänger frei wählbar. Ein Rechnungs-/Gutschrift-**Entwurf** wird je nach Einstellung `autoFinalizeOnSend` (§33) vor dem Versand automatisch festgeschrieben oder unverändert als Entwurf verschickt | „Sende RE-2026-00342 per E-Mail an buchhaltung@mueller.de." |

### Dateien

| Tool | Zweck | Beispiel |
|---|---|---|
| `get_document_file` | Beleg (Rechnung/Angebot-AB-Proforma/Lieferschein/Mahnung) als Base64-Datei zurückgeben — PDF für alle vier Belegarten, XRechnung/ZUGFeRD nur für festgeschriebene Rechnungen (`kind=INVOICE`); Antworten über 10 MB werden abgelehnt | „Gib mir das PDF von Angebot ANG-2026-00123 als Datei." |

### Anhänge

| Tool | Zweck | Beispiel |
|---|---|---|
| `add_attachment` | Beleganhang hochladen (Rechnung/Angebot/Lieferschein/Abo/Mahnung), Dateiinhalt als Base64, gleiche Grenzen wie im UI (10 MB je Datei, 50 MB je Beleg) | „Hänge dieses PDF als Anhang an RE-2026-00342 an." |
| `list_attachments` | Anhänge eines Belegs auflisten | „Welche Anhänge hat RE-2026-00342?" |
| `remove_attachment` | Anhang von einem Beleg entfernen | „Entferne den zweiten Anhang von RE-2026-00342." |

### Belegvorlagen (Phase 13d)

| Tool | Zweck | Beispiel |
|---|---|---|
| `list_templates` | Belegvorlagen auflisten, optional nach Belegtyp gefiltert (INVOICE/QUOTE/DELIVERY_NOTE) | „Welche Vorlagen habe ich für Rechnungen?" |
| `create_template_from_document` | Den aktuellen Stand eines gespeicherten Belegs (Belegnummer oder ID) als wiederverwendbare Vorlage speichern — Positionen + Kopf-Metadaten, ohne Belegnummer/Datum/Snapshots/interne Notizen (§48); eine Vorlage ist ein Schnappschuss und ändert sich nicht mit dem Ursprungsbeleg | „Speichere RE-2026-00342 als Vorlage ‚Wartung monatlich'." |
| `apply_template` | Aus einer Vorlage (Name oder ID) einen neuen Belegentwurf erzeugen — dieselbe Domain-Funktion wie /vorlagen (gleiche Steuersatz-/Kundenprüfung, kein Bypass); optional ein Kunde (Name oder ID), falls die Vorlage noch keinen festlegt | „Erzeuge aus der Vorlage ‚Wartung monatlich' eine Rechnung an Müller GmbH." |

### Tags (Phase 13d)

Tags sind reine interne Metadaten (kein GoBD-Belegbestandteil) — setz-/entfernbar auch an festgeschriebenen Rechnungen, erscheinen nie in PDF/XRechnung/ZUGFeRD/Kunden-Mail/öffentlichem Angebotslink.

| Tool | Zweck | Beispiel |
|---|---|---|
| `list_tags` | Tags der Organisation auflisten (mit Zuordnungszahl) | „Welche Tags gibt es?" |
| `create_tag` | Tag anlegen (Name je Organisation eindeutig, Farbe aus acht festen Werten) | „Leg einen Tag ‚Wartung' an." |
| `delete_tag` | Tag (Name oder ID) samt aller Zuordnungen löschen — rührt keinen Beleg an | „Lösche den Tag ‚Wartung'." |
| `tag_document` | Tag (Name oder ID) einem Beleg (Belegnummer oder ID) zuordnen — idempotent | „Setze den Tag ‚Wartung' auf RE-2026-00342." |
| `untag_document` | Tag-Zuordnung von einem Beleg entfernen — idempotent, kein Fehler ohne bestehende Zuordnung | „Entferne den Tag ‚Wartung' von RE-2026-00342." |

### CSV-Export (Phase 18b)

Dieselben Listenfilter und dieselbe Sortierung wie die `list_*`-Werkzeuge und `GET /api/v1/<Ressource>?format=csv`; interne Notizen sind nie enthalten.

| Tool | Zweck | Beispiel |
|---|---|---|
| `export_csv` | Rechnungen, Angebote, Auftragsbestätigungen, Lieferscheine, Kunden oder Produkte als CSV zurückgeben (`resource`: `invoices`, `quotes`, `order-confirmations`, `delivery-notes`, `contacts`, `products`; optional `filter` wie bei `list_*`). Semikolon, CRLF, deutsche Zahlen, ohne BOM; keine Paginierung, höchstens 500 Zeilen (sonst Fehler mit Hinweis auf REST `?format=csv` oder die Oberfläche für größere Mengen), 30 Exporte je Minute und Organisation | „Exportiere alle bezahlten Rechnungen als CSV." |

### CSV-Import (Phase 18b)

Legt nur neue Kunden bzw. Produkte an (kein Update); alle Zeilen oder keine. Gleiche Prüfungen und Grenzen wie `POST /api/v1/Contact/import` und `/api/v1/Product/import` (höchstens 2 MB, 2.000 Zeilen; 20 Vorschauen und 5 Importe je Minute und Organisation).

| Tool | Zweck | Beispiel |
|---|---|---|
| `import_contacts` | Kunden aus CSV-Text (`csv`) anlegen; `dryRun` ist Standard `true` (nur Vorschau mit Fehlern je Zeile/Spalte, ohne Beispielzeilen), `dryRun: false` legt an und verlangt `expectedHash` (`fileHash` der Vorschau); optional `fileName`; dieselbe Datei (gleicher Inhalts-Hash) wird je Organisation innerhalb von 24 Stunden nur einmal importiert, `allowRepeat: true` hebt das bewusst auf | „Prüfe diese Kundenliste als CSV und importiere sie, wenn sie fehlerfrei ist." |
| `import_products` | Produkte aus CSV-Text (`csv`) anlegen; sonst wie `import_contacts` | „Importiere diese Artikelliste als Produkte." |
| `create_contacts` | 1 bis 100 Kunden (`contacts`, Felder wie `upsert_customer`) in einem Schritt anlegen, alles oder nichts (nur Anlage; Duplikate und Fehler lehnen die gesamte Sammelanlage ab); Fehler mit Index, Feld und Meldung je Eintrag (höchstens 20 angezeigt); höchstens 10 Aufrufe pro Minute | „Lege diese drei Kunden an." |

### Einstellungen

| Tool | Zweck | Beispiel |
|---|---|---|
| `get_settings` | Einstellungen lesen (`area`: `documents`/`print`/`branding`/`numberRanges`/`dunning`; bei `numberRanges` optional `year`) — `documents` enthält `taxRates`, `branding` die vier Marke-Felder `appName`/`appShortName`/`faviconPath`/`appLogoPath` (Phase 12c) | „Zeig mir meine Beleg-Einstellungen." |
| `update_document_settings` | Belegeinstellungen teilweise aktualisieren (u. a. Fälligkeitstage, Standardwährung, Angebotsgültigkeit, Automatik-Festschreiben/-Versand, `viesCheckEnabled`/`viesCheckOnFinalize` (USt-IdNr.-Prüfung über VIES, Phase 17a), `taxRates` — freigegebene Steuersätze der Organisation, 1–10 ganze Prozentwerte 0–100, Phase 12c) — Merge; ein nicht freigegebener Satz auf einem bestehenden Beleg/Produkt wird abgelehnt, nicht die Einstellung selbst | „Setze die Fälligkeitstage für Rechnungen auf 14." |
| `update_print_settings` | Globale Druckoptionen teilweise aktualisieren (Fußzeile, Seitenzahlen, Falz-/Lochmarken, Spalten, GiroCode, GiroCode-Größe 15–40 mm) — Merge | „Aktiviere den GiroCode auf Rechnungen." |
| `update_branding_settings` | Briefpapier teilweise aktualisieren (Farbe, Ränder, Schriftgröße, Absender-/Fußzeile) sowie das PDF-Layout (`layoutId`, `layoutByType` je Belegtyp, `footerMode` AUTO/CUSTOM, Phase 11b) **und** die Marke (`appName` max. 40 Zeichen, `appShortName` max. 12 Zeichen, Phase 12c) — Merge; Favicon-/Logo-Upload nur über die HTTP-Route | „Setze die Akzentfarbe im Briefpapier auf #1A237E." |
| `list_pdf_layouts` | Die sieben wählbaren PDF-Layouts auflisten (id, name, description) — ohne Eingabe | „Welche PDF-Layouts gibt es?" |
| `list_layout_designs` | Layout-Designs der Organisation auflisten (id, ref `design:<id>`, name, baseLayoutId, currentVersion, archived; `includeArchived`) | „Welche Layout-Designs gibt es?" |
| `save_layout_design` | Layout-Design anlegen oder (mit `id`) als neue Version speichern, optional `archived`; dieselbe Validierung wie REST und UI (Pflichtblöcke, Anschriftfenster) | „Lege ein Design ‚Post‘ auf Basis von klassik an." |
| `preview_layout_design` | PDF-Vorschau eines Designs oder einer Version (Datei `exports/layout-vorschau-<id>.pdf`) | „Zeig mir die Vorschau von Design X." |
| `update_number_range` | Einen Nummernkreis aktualisieren (`docType`, Muster/Präfix/Padding/`yearlyReset`/nächste Nummer) — Merge mit dem laufenden Jahr; lehnt ein Zurückdrehen unterhalb bereits vergebener Nummern ab | „Setze das Rechnungspräfix auf RE-2026-." |
| `update_dunning_settings` | Org-weite Mahnwesen-Einstellungen teilweise aktualisieren (Auto-Erstellung/-Versand, Karenztage) — Merge. **Altschreibweg:** ein mitgeschicktes `baseInterestRateBp`/`baseRateValidFrom` legt zusätzlich einen Eintrag in der Basiszinssatz-Historie an (siehe `set_base_interest_rate`) — neu: `list_base_interest_rates`/`set_base_interest_rate`/`delete_base_interest_rate` verwenden | „Aktiviere automatischen Mahnungsversand." |
| `list_base_interest_rates` | Basiszinssatz-Historie auflisten (§ 288 Abs. 1 Satz 2 BGB, Phase 14a) — aufsteigend nach „gültig ab"; seit Phase 14a die alleinige Quelle der Verzugszinsberechnung | „Welche Basiszinssätze sind hinterlegt?" |
| `set_base_interest_rate` | Basiszinssatz zu einem Stichtag anlegen oder überschreiben (Upsert auf „gültig ab", `rateBp` in Basispunkten, 127 = 1,27 %) — wirkt erst auf danach erstellte Mahnungen | „Trage zum 01.07.2026 einen Basiszins von 3,42 % ein." |
| `delete_base_interest_rate` | Basiszinssatz-Eintrag löschen — der letzte verbleibende Eintrag ist geschützt | „Lösche den Basiszins-Eintrag zum 01.01.2024." |
| `set_print_options` | Beleg-individuelle Überschreibung der globalen Druckoptionen (§36) sowie optional des PDF-Layouts (`layoutId`, Phase 11b) setzen — nur solange der Beleg noch `DRAFT` ist; ersetzt die bisherige Überschreibung (kein Merge) | „Schalte für diese eine Rechnung die Seitenzahlen aus." |

### API-Schluessel

| Tool | Zweck | Beispiel |
|---|---|---|
| `create_api_key` | Neuen API-Schluessel fuer `/api/v1` erzeugen (Name, Scopes read/write/send/admin, optional Ablauf) — das Klartext-Token wird NUR in dieser Antwort angezeigt | „Erzeuge einen API-Schluessel ‚Buchhaltung' mit Lese- und Schreibrechten." |
| `revoke_api_key` | API-Schluessel unwiderruflich widerrufen (idempotent) | „Widerrufe den API-Schluessel ‚Buchhaltung'." |
| `list_api_keys` | API-Schluessel auflisten (Name, Praefix, Scopes, zuletzt genutzt, Ablauf, Widerruf) — nie das Klartext-Token | „Welche API-Schluessel gibt es?" |

### Webhooks

| Tool | Zweck | Beispiel |
|---|---|---|
| `list_webhooks` | Webhook-Endpunkte auflisten (URL, abonnierte Ereignisse, aktiv) — nie das Secret | „Welche Webhooks sind eingerichtet?" |
| `upsert_webhook` | Webhook-Endpunkt anlegen oder aendern (URL, Events, aktiv) — Klartext-Secret nur bei Neuanlage/Rotation sichtbar | „Lege einen Webhook auf https://example.com/hook fuer invoice.finalized und payment.recorded an." |
| `test_webhook` | Synthetische Test-Zustellung an einen Endpunkt senden und Ergebnis melden | „Teste den Webhook ‚https://example.com/hook'." |
| `replay_webhook_delivery` | Eine bestehende Zustellung als NEUE Zustellung erneut versuchen (Original bleibt unveraendert) | „Wiederhole die fehlgeschlagene Zustellung xyz." |

### Abos (wiederkehrende Rechnungen)

| Tool | Zweck | Beispiel |
|---|---|---|
| `create_recurring` | Abo / wiederkehrende Rechnung anlegen (optional `currency`; Positionen mit `lineType` `ITEM`/`HEADING`/`TEXT`/`SUBTOTAL`, `descriptionLong`, `articleNumber` und Rabatt wie bei `update_invoice_draft`) | „Leg einen monatlichen Wartungsvertrag für Müller über 99 € an, ab dem 1. des nächsten Monats." |
| `list_recurring` | Abos auflisten (Filter u. a. Status) | „Welche Abos sind fällig?" |
| `run_recurring` | Fällige Abo-Rechnungen erzeugen (alle, oder ein Abo sofort) | „Erzeuge die fälligen Rechnungen." |
| `update_recurring_invoice` | Bestehendes Abo teilweise aktualisieren (Titel, Rhythmus inkl. täglich, Start-/Enddatum, maximale Läufe, Zahlungsfrist, Positionen, Auto-Festschreiben/-Versand, E-Mail-Vorlage, Leistungszeitraum-Text) — Merge, kein Kundenwechsel möglich | „Ändere beim Wartungsvertrag von Müller den Preis auf 109 €." |
| `set_recurring_state` | Status eines Abos auf `ACTIVE`/`PAUSED`/`ENDED` setzen (dünner Wrapper um `update_recurring_invoice`) | „Pausiere den Wartungsvertrag von Müller GmbH." |

### Scheduler

| Tool | Zweck | Beispiel |
|---|---|---|
| `run_scheduler_job` | Scheduler-Job(s) manuell anstoßen (`dunning`, `recurring`, oder beide — dieselbe Runner-Funktion wie der eingebaute Loop/Cron) | „Führe jetzt den Mahnlauf aus." |

### Dashboard, Timeline, Benachrichtigungen

| Tool | Zweck | Beispiel |
|---|---|---|
| `get_dashboard` | Dashboard-Kennzahlen: offen/fällig/überfällig, „fällig diese Woche", teilbezahlt, Anzahl mahnwürdiger Rechnungen, Aging-Buckets, Nettoumsatz laufender Monat, letzte Belege, offene Angebote | „Wie ist die Lage — was ist offen und überfällig?" |
| `get_report` | Auswertung (Phase 12e): `revenue` (Netto-Umsatz je Monat und Währung), `top-customers` (nach Netto), `status` (Rechnungen je effektivem Status) oder `payment-behaviour` (Ø Zahlungsdauer, Pünktlichkeitsanteil), `cash-in` (Zahlungseingang je Monat/Währung), `quote-outcome` (Angebotsquote), `top-products` (Nettoumsatz je Produkt) oder `recurring-run-rate` (monatlich wiederkehrender Netto-Umsatz aktiver Abos) — `customer` (ID oder Name) nur bei `revenue`/`payment-behaviour`, `months` nur bei `revenue`/`top-customers`/`cash-in`/`quote-outcome`/`top-products`, `limit` nur bei `top-customers`/`top-products`; `currency` (ISO-Code, z. B. `EUR`) nur bei `revenue`; `format` (`json` Standard oder `csv`, bei jedem `type`; CSV = Semikolon, Dezimalkomma, BOM-frei als Text, Formelschutz, gleiche Tabelle wie REST `format=csv`); ein beim gewählten `type` nicht zulässiger Parameter wird mit einer Fehlermeldung abgelehnt (Fix 2, ehem. M8) | „Wie war der Umsatz der letzten sechs Monate, und wer sind meine Top-5-Kunden?" |
| `get_timeline` | Chronologische Historie eines Belegs (`kind`: Rechnung/Angebot/Lieferschein + `doc`-ID) — Anlage, Änderungen, Festschreibung, Versand, Zahlungen, Mahnungen, Statuswechsel | „Zeig mir die Historie von RE-2026-00342." |
| `get_oss_threshold` | OSS-Schwelle (§ 3c Abs. 4 UStG, Phase 16e): EU-B2C-Netto-Umsatz des Jahres und des Vorjahres gegen 10.000 €, `level` OK/WARN/EXCEEDED, Summen je Land, Zählmodus, `skippedWithoutEur`; `year` optional. Produkte, Positionen und `get_settings` (`documents`) tragen `ossCategory`, `ossCountMode`, `ossWarnPercent`; `create_invoice`, `create_document`, `create_recurring` und `update_invoice_draft` nehmen je Position `ossCategory` an (sonst Snapshot aus dem Produkt) | „Wie nah bin ich an der OSS-Schwelle?" |
| `list_notifications` | Benachrichtigungen auflisten (optional nur ungelesen, `limit`) | „Welche ungelesenen Benachrichtigungen habe ich?" |
| `mark_notifications_read` | Benachrichtigungen als gelesen markieren (einzelne IDs oder alle) | „Markiere alle Benachrichtigungen als gelesen." |

### Freigabelinks (Angebots-Annahme)

| Tool | Zweck | Beispiel |
|---|---|---|
| `create_share_link` | Angebots-Annahmelink (ohne Login) erzeugen — liefert die URL einmalig in der Antwort | „Erstelle einen Annahmelink für Angebot ANG-2026-00123." |
| `list_share_links` | Annahme-Links eines Angebots auflisten (Status/Aufrufe/Entscheidung, nie der Klartext-Token) | „Welche Annahmelinks gibt es für Angebot ANG-2026-00123?" |
| `revoke_share_link` | Angebots-Annahmelink widerrufen | „Widerrufe den Annahmelink für Angebot ANG-2026-00123." |

## 4. Was die KI **nicht** kaputt machen kann

- **Festschreiben blockt** bei fehlenden Pflichtangaben (z. B. Leistungsdatum, Steuernummer) und liefert die genaue Liste zurück — der Assistent ergänzt und versucht es erneut.
- **Festgeschriebene Rechnungen sind unveränderbar** (GoBD) — Korrektur nur per Storno/Gutschrift/Korrekturrechnung.
- **Steuerschema** (Kleinunternehmer, Reverse Charge …) ergänzt automatisch den Pflichthinweis und weist keine USt aus.
  Für Dienstleistungen an Drittland-Kunden: `taxScheme` `NICHT_STEUERBAR` (Positionen mit `taxCategory` `O`, 0 %); `AUSFUHR`/`G` nur für Warenlieferungen.

## 5. Grenzen

Jede exportierte XRechnung besteht die **offiziellen Schematron-Regeln** (EN-16931 + XRechnung-CIUS/BR-DE) — `npm run validate:erechnung`, via SaxonJS, ohne Java; in CI hart geprüft. Siehe [LIMITATIONEN.md](LIMITATIONEN.md) — u. a. Single-User-Anmeldung (Admin-Konto; Multi-User/Rollen Roadmap), XRechnung statt ZUGFeRD-Hybrid. Keine Steuerberatung — [COMPLIANCE.md](../COMPLIANCE.md).

## Entfernt

Frühere Toolnamen, die es nicht mehr gibt (Aufrufe darauf schlagen fehl):

- `save_document_settings` — ersetzt durch `update_document_settings`.
