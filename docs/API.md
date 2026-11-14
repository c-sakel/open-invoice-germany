# REST-API (`/api/v1`)

OpenInvoice Germany bietet neben UI und MCP-Server eine **öffentliche, versionierte
REST-API** unter `/api/v1`. Sie ruft **exakt dieselben Domain-Funktionen** wie UI und
MCP auf (kein Bypass) — GoBD-Regeln (festgeschriebene Belege nur über Storno/
Gutschrift/Korrektur), § 14-Pflichtangaben und die EN-16931-Validierung gelten
unverändert.

## Authentifizierung

Jeder API-Aufruf braucht einen **API-Schlüssel** als Bearer-Token:

1. **Einstellungen → API** → „Schlüssel anlegen" → Name, Scopes (`read`, `write`,
   `send`, `admin`), optional ein Ablaufdatum.
2. Das Token (`oig_<32 Byte base64url>`) wird **einmalig** angezeigt — sicher
   aufbewahren, es lässt sich nicht erneut abrufen.
3. Jeder Request sendet `Authorization: Bearer oig_...`.

`/api/v1/*` akzeptiert **ausschließlich** Bearer-Token, kein Session-Cookie. Ein
Schlüssel ohne den passenden Scope liefert `403 FORBIDDEN`.

Konto-Sicherheit (Passwort, Zwei-Faktor-Anmeldung, Passwort-Reset) läuft nur über die Sitzung der Weboberfläche; API-Schlüssel und Scopes bleiben davon unberührt.

| Scope   | Bedeutung |
|---------|-----------|
| `read`  | Lesen (GET) |
| `write` | Anlegen/Ändern/zustandsändernde Aktionen (finalisieren, stornieren, Zahlung erfassen, …) |
| `send`  | E-Mail-Versand und Mahnungen (`/send`, `/dunning`) |
| `admin` | Einstellungen (`/Settings`), Basiszinssatz-Historie (`/BaseInterestRate`), API-Schlüsselverwaltung (`/ApiKey`) und Webhook-Endpunkte (`/Webhook`) |

## Antwortformat

Einzelobjekt:

```json
{ "data": { "objectName": "Invoice", "id": "...", "...": "..." } }
```

Liste (Paginierung `limit`/`offset`, Default `limit=50`, max. `200`):

```json
{ "data": [ /* ... */ ], "total": 42, "limit": 50, "offset": 0 }
```

Fehler — einheitlich für jeden Endpunkt:

```json
{ "error": { "code": "VALIDATION", "message": "...", "details": { "issues": [ /* Zod */ ] } } }
```

`code` ist einer von `VALIDATION` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403),
`NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429),
`IDEMPOTENCY_MISMATCH`/`IDEMPOTENCY_IN_PROGRESS` (409, siehe unten),
`EINVOICE_INVALID` (409, EN-16931-Kernvalidierung bei `/xrechnung`/`/zugferd`) oder
`INTERNAL` (500).

## Rate-Limit & Idempotenz

- **600 Anfragen/Minute** je Schlüssel. Jede Antwort trägt `X-RateLimit-Remaining`;
  bei Überschreitung `429` + `Retry-After` (Sekunden).
- Schreibende `POST`-Aktionen unterstützen den Header `Idempotency-Key` (1–128
  Zeichen): derselbe Schlüssel + derselbe Request-Body liefert immer dieselbe
  Antwort erneut, ohne den Effekt zu wiederholen (z. B. keine doppelte Zahlung bei
  einem Netzwerk-Retry). Ein abweichender Body unter demselben Schlüssel liefert
  `409 IDEMPOTENCY_MISMATCH`; ein zeitgleicher zweiter Request mit demselben
  Schlüssel liefert `409 IDEMPOTENCY_IN_PROGRESS` (kurz erneut senden).

## Interaktive Dokumentation

`GET /api/docs` — Swagger-UI (Session-Login oder API-Schlüssel), interaktiv gegen
die eigene Instanz nutzbar ("Authorize" → Bearer-Token einfügen). Das zugrunde
liegende OpenAPI-3.1-Dokument steht maschinenlesbar unter
`GET /api/v1/openapi.json` (ebenfalls Session oder Bearer). Per API-Schlüssel
reicht dafür der Scope `read` — ein Schlüssel ganz ohne `read`-Scope (z. B. nur
`write`/`send`) wird abgelehnt, auch wenn er sonst gültig ist.

## Kompletter Ablauf per curl: Kunde → Rechnung → festschreiben → PDF/XRechnung → Zahlung

Alle Beispiele setzen `TOKEN` (siehe oben) und `BASE` (z. B. `http://localhost:3000`)
voraus:

```bash
export BASE="http://localhost:3000"
export TOKEN="oig_...dein-schluessel..."
AUTH="Authorization: Bearer $TOKEN"
```

### 1. Kunde anlegen

```bash
curl -s -X POST "$BASE/api/v1/Contact" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
        "type": "BUSINESS",
        "name": "Müller GmbH",
        "addressLine1": "Musterstraße 1",
        "postalCode": "12345",
        "city": "Berlin",
        "countryCode": "DE",
        "email": "buchhaltung@mueller-gmbh.de"
      }'
```

Antwort: `{ "data": { "objectName": "Contact", "id": "cl...", "name": "Müller GmbH", ... } }`
— die `id` wird im nächsten Schritt als `customerId` gebraucht.

### 2. Rechnungsentwurf anlegen

```bash
curl -s -X POST "$BASE/api/v1/Invoice" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{
        "customerId": "cl...",
        "lines": [
          { "description": "Beratung", "quantityMilli": 3000, "unit": "HUR",
            "unitNetPriceCents": 9500, "taxRate": 19 }
        ]
      }'
```

Antwort enthält `data.id` (Rechnung, Status `DRAFT`, noch keine Rechnungsnummer).

**Kunden im Ausland (Webshop-Anbindung):** Das Steuerschema (`taxScheme`) muss gesetzt werden; fehlt `lines[].taxCategory`, wird sie aus dem Schema abgeleitet (z. B. `NICHT_STEUERBAR` → `O`, `AUSFUHR` → `G`, `IG_LIEFERUNG` → `K`). Eine ausdrücklich gesetzte Kategorie bleibt unverändert. Bei einem Teil-Update ohne `taxScheme` wird gegen das gespeicherte Schema des Belegs abgeleitet.

| Fall | `taxScheme` | `lines[].taxCategory` / `taxRate` | Hinweis |
|---|---|---|---|
| Dienstleistung an Unternehmer im **Drittland** (§ 3a Abs. 2) oder elektronische Leistung (z. B. Hosting, § 3a Abs. 5 S. 2 Nr. 3) bzw. Katalogleistung (§ 3a Abs. 4) an Privatkunden im Drittland; Empfängerland darf weder leer noch DE/EU sein | `NICHT_STEUERBAR` | `O` / `0` | `notes`: „Nicht im Inland steuerbare Leistung (Leistungsort außerhalb Deutschlands, § 3a UStG)" (Pflicht beim Festschreiben); alle Positionen `O` |
| **Warenlieferung** ins Drittland | `AUSFUHR` | `G` / `0` | `notes`: „Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG)" |
| Warenlieferung an EU-Unternehmer | `IG_LIEFERUNG` | `K` / `0` | siehe COMPLIANCE.md § 8 |

`G` (Ausfuhrlieferung) gilt nur für Waren. Webshop-Hinweis: Dienstleistungen an Drittland-Kunden sind nur bei B2B (§ 3a Abs. 2 UStG) sowie bei elektronischen Leistungen/Katalogleistungen an Privatkunden nicht steuerbar (Kategorie `O`); sonstige B2C-Leistungen bleiben nach § 3a Abs. 1 UStG in Deutschland steuerbar (`REGULAR`). Das Land des Kunden (`countryCode`) steht immer als letzte Anschriftszeile im PDF (auch „DEUTSCHLAND“); bei 0-%-Positionen druckt das PDF den Grund je Steuerkategorie auch ohne `notes`-Hinweis.

### 3. Festschreiben (GoBD: unveränderbar ab hier)

```bash
curl -s -X POST "$BASE/api/v1/Invoice/<id>/finalize" -H "$AUTH"
```

Vergibt die Rechnungsnummer aus dem Nummernkreis und schreibt die Rechnung fest.
Erneutes Festschreiben derselben Rechnung liefert `409 CONFLICT`.

Die Antwort kann ein Feld `warnings` (Liste von Texten) enthalten: `{ "data": { ... }, "warnings": ["..."] }`. Die Hinweise blockieren das Festschreiben nie, z. B. wenn dem Käufer jede elektronische Adresse fehlt (XRechnung-Regel `PEPPOL-EN16931-R010`) oder eine ig. Lieferung/Leistung ohne gültige VIES-Prüfung festgeschrieben wird (VIES-Fehler, ungültige USt-IdNr., Abfragelimit).

### USt-IdNr.-Prüfung und neue Kontaktfelder (Phase 17a)

- `Contact` und `PATCH /api/v1/Contact/{id}` kennen zusätzlich `peppolScheme` (EAS-Schemacode der `peppolId`, z. B. `0088`; eine leere `peppolId` setzt das Schema auf `null`) und `legalRegistrationId` (BT-47, Handelsregister-/Unternehmensnummer). `leitwegId` wird mit Prüfziffer geprüft (400 `VALIDATION` bei Fehler).
- `POST /api/v1/Contact/{id}/vat-check` prüft die USt-IdNr. des Kontakts qualifiziert über VIES und liefert den Protokolleintrag (`status` `VALID`/`INVALID`/`ERROR`, `requestIdentifier`, `traderName`, `traderAddress`, `checkedAt`). Fehler: 409, wenn die Prüfung in den Einstellungen abgeschaltet ist; 429 mit `Retry-After` bei mehr als 20 Abfragen je Minute; 400 bei fehlender USt-IdNr.; 404 für fremde Organisation. Dienstausfälle ergeben `status: "ERROR"`, nie 5xx.
- `GET /api/v1/Contact/{id}/vat-checks` listet das Prüfprotokoll (neueste zuerst, höchstens 50 Einträge; `total` ist die Gesamtzahl der Einträge des Kontakts).
- `Settings.documents` kennt `viesCheckEnabled` (Prüfung freischalten, Standard `true`) und `viesCheckOnFinalize` (Prüfung beim Festschreiben, Standard `false`); `PATCH` ändert nur gesendete Felder.

### Lastschriftmandat und Kartenangaben (Phase 18e)

- **`Contact`** (`POST /api/v1/Contact`, `PATCH /api/v1/Contact/{id}`) kennt die Mandatsfelder `sepaMandateReference` (Mandatsreferenz, höchstens 35 Zeichen aus `A-Z a-z 0-9 + ? / - : ( ) . , '`), `sepaMandateSignedAt` (Datum der Unterschrift), `sepaDebitIban` (**nur Eingabe**) und `sepaDebitAccountName`. Referenz und IBAN gehören zusammen: ist eines der Mandatsfelder gesetzt, muss auch das andere vorhanden sein (sonst 400 `VALIDATION` mit Feldpfad). Referenz **und** IBAN beide leer entfernt das Mandat (Datum und Kontoinhaber werden mitgeleert; wer sie dabei mitsendet, erhält 400). Die Ausgabe enthält `sepaMandateReference`, `sepaMandateSignedAt` (`YYYY-MM-DD`), `sepaDebitAccountName` und `sepaDebitIbanMasked` (z. B. `DE02 **** 2051`) — **die volle IBAN wird nie ausgegeben**.
- **`Invoice`** (`POST`, `PATCH` am Entwurf) nimmt `cardPanTruncated`, `cardNetwork` und `cardHolderName` an. Nur bei einer Zahlungsmethode mit UNTDID-Code `48`, `54` oder `55` wirksam, sonst werden sie auf `null` gesetzt; nach dem Festschreiben nicht mehr änderbar. **PAN-Regel:** `cardPanTruncated` akzeptiert 4 bis 10 Ziffern (Leerzeichen, `*`, `x`, `X`, `-`, `.` erlaubt) und speichert **nur die letzten 4**; mehr als 10 Ziffern ergibt 400, die Fehlermeldung wiederholt die Eingabe nie. Die Ausgabe enthält `cardPanTruncated`, `cardNetwork`, `cardHolderName` und `directDebit` (`{ mandateReference, creditorId, debtorIbanMasked }`, ab Festschreibung bei Lastschrift mit vollständigen Angaben, sonst `null`).
- Das **Anfrageprotokoll** redigiert Schlüssel mit `iban`, `cardpan`, `cardholdername`, `sepadebitaccountname` und `mandate` (`[redaktiert]`).
- Die interne Kunden-Übersicht (`GET /api/customers/{id}/overview`) liefert zusätzlich `sepaMandateReference`, `sepaMandateSignedAt` und `sepaDebitIbanMasked` (maskiert) im Block `customer`.

### 4. PDF und XRechnung abrufen

```bash
curl -s "$BASE/api/v1/Invoice/<id>/pdf" -H "$AUTH" -o rechnung.pdf
curl -s "$BASE/api/v1/Invoice/<id>/xrechnung" -H "$AUTH" -o rechnung.xml
```

Beide liefern die Datei direkt als Bytes (kein `{data}`-Umschlag), Content-Type
`application/pdf` bzw. `application/xml`. Schlägt die EN-16931-Kernvalidierung fehl
(z. B. unvollständige Verkäuferadresse), antwortet `/xrechnung` bzw. `/zugferd` mit
`409 EINVOICE_INVALID` und `error.details.issues`.

### 5. Zahlung erfassen

```bash
curl -s -X POST "$BASE/api/v1/Invoice/<id>/payment" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -H "Idempotency-Key: zahlung-2076-09-04-001" \
  -d '{ "amountCents": 33915, "method": "TRANSFER" }'
```

Der `Idempotency-Key` sorgt dafür, dass ein wiederholter Request (z. B. Timeout im
Client) nicht zweimal gebucht wird — derselbe Schlüssel liefert dieselbe Antwort
erneut. Nach vollständiger Zahlung wechselt die Rechnung auf Status `PAID`.

Zahlungen mit `method: "CREDIT_NOTE"` entstehen automatisch, wenn eine Teilgutschrift
(`POST /api/v1/Invoice/{id}/credit`) den offenen Rest der Rechnung mindert (Verrechnung,
kein Geldeingang; Anzeige „Verrechnung Gutschrift“). Die Rechnung wird dann `PARTIALLY_PAID`
bzw. `PAID`; ein darüber hinausgehender Gutschriftsbetrag ist zu erstatten. Die Summe aller
Gutschriften darf den Rechnungsbetrag nicht übersteigen, auf stornierte Rechnungen ist keine
Teilgutschrift möglich (jeweils 409). In der E-Rechnung des Originals zählen Verrechnungen
nicht als bezahlt (BT-113). Hinweis: Eine Gutschrift über den vollen Betrag setzt das Original auf `PAID`, obwohl
kein Geldeingang erfolgt ist (reine Verrechnung); als Obergrenze für Gutschriften gilt der Rechnungsbetrag
(bei Schlussrechnungen der volle Bruttobetrag, nicht der um Abschläge reduzierte Zahlbetrag).

## Anfrageprotokoll

Jede Antwort von `/api/v1/*` — Erfolg **und** Fehler — trägt den Header
`X-Request-Id` (UUID), **mit Ausnahme von** `GET /api/v1/openapi.json` (läuft
bewusst ohne den `withApi`-Wrapper, siehe „Was NICHT protokolliert wird"
unten). Ist das Anfrageprotokoll für die Organisation eingeschaltet
(**standardmäßig AUS**, `Einstellungen → API → Anfrageprotokoll`), landet zu
jeder protokollierten Anfrage eine Zeile mit **derselben** Kennung in
`ApiRequestLog.requestId` — der Header eignet sich damit als Suchschlüssel beim
Support/Debugging.

`GET /api/v1/ApiRequestLog` (Filter: `apiKeyId`, `errorsOnly`, `path`, `from`/
`to`, `limit`/`offset`) und `GET /api/v1/ApiRequestLog/{id}` — Scope `read`,
**ausschließlich lesend**: kein `POST`/`PATCH`/`DELETE` über die API, Löschen
("Protokoll leeren") und die Einstellungen (`logRequests`/`logBodies`/
`retentionDays`/`maxRows`) sind ausschließlich über die Session-Route der UI
erreichbar (`Einstellungen → API`), nicht über `/api/v1`. Die Listenantwort
enthält aus Datenminimierungsgründen **keine** Request-/Response-Bodies (immer
`null`) — volle Bodies (sofern gespeichert) liefert nur der Einzelabruf
`GET /api/v1/ApiRequestLog/{id}`.

**Was im „nur Kopfdaten"-Modus (`logRequests` an, `logBodies` aus) gespeichert
wird:** Methode, Pfad **inklusive Query-String** (Parameter mit verdächtigem
Namen — Geheimnis-Muster wie `token`/`secret`/`password`/`apiKey`/`iban`/`bic`
sowie `email` — werden vor dem Speichern geschwärzt; scheitert die Schwärzung
ausnahmsweise, wird der Pfad **ohne** Query gespeichert), Status, Dauer,
`apiKeyId`, Request-ID sowie **IP-Adresse und User-Agent** des Aufrufers. Nur
Request-/Response-Bodies hängen zusätzlich am separaten Schalter `logBodies`.

**Was NICHT protokolliert wird:**
- Anfragen, die die Authentifizierung nicht passieren — ein `401` mit
  unbekanntem/ungültigem Schlüssel oder ein Vor-Auth-`429` — es gibt in diesem
  Fall keine Organisation, der die Zeile zuzuordnen wäre.
- `GET /api/docs`, `GET /api/v1/openapi.json`, `GET /api/v1/ping` sowie
  `/api/v1/ApiRequestLog` selbst (Rekursionsschutz) — diese Pfade tragen nichts
  zur Fehlersuche bei.

## Auswertungen (Phase 12e)

`GET /api/v1/Report` (Scope `read`) liefert dieselben Auswertungen wie die Diagramme
auf Dashboard und Kundenseite — **keine eigene Aggregation** für die API, sondern
derselbe Kern (`runReport`, `src/domain/reporting/query.ts`), den auch das MCP-Tool
`get_report` aufruft. Kein Eintrag in der CRUD-Ressourcenliste unten: `Report` ist
rein lesend und keine Tabelle, die Antwortform ist bewusst `{ data: <typabhängig> }`
ohne festes Ressourcenschema (wie bei den Aktions-Endpunkten).

Parameter (Query):

| Parameter | Pflicht | Bedeutung |
|---|---|---|
| `type` | ja | `revenue` \| `top-customers` \| `status` \| `payment-behaviour` \| `cash-in` \| `quote-outcome` \| `top-products` \| `recurring-run-rate` |
| `months` | nein | Anzahl Kalendermonate rückwirkend (1–36, Default 12) — **nur bei `revenue`, `top-customers`, `cash-in`, `quote-outcome` und `top-products` zulässig** (Fix 2, ehem. M8) |
| `limit` | nein | Anzahl Zeilen (1–50, Default 5; bei `top-products` Default 10, je Währung) — **nur bei `top-customers` und `top-products` zulässig** |
| `customerId` | nein | auf einen Kunden einschränken — **nur bei `revenue` und `payment-behaviour` zulässig** |
| `currency` | nein | nur Belege dieser Währung (ISO-4217, Großbuchstaben, z. B. `EUR`) — **nur bei `revenue` zulässig**; ohne Angabe je Währung eigene Zeilen |

Ein unbekannter `type`, `months`/`limit` außerhalb ihrer Grenzen ODER ein beim
gewählten `type` **nicht zulässiger** Parameter (z. B. `limit` bei
`type=revenue`, `months` bei `type=status`) liefert `400 VALIDATION` — die
Meldung (`error.details.issues`) nennt den betroffenen Parameter. Vor Fix 2
wurde ein nicht zutreffender Parameter still ignoriert; das ist seither ein
Fehler, kein No-op mehr.

- **`revenue`** — Netto-Umsatz je Kalendermonat und Währung (Feld `currency`, nie über
  Währungen addiert), lückenlos je Währung (auch Monate ohne Beleg als 0), Entwürfe ausgeschlossen, Gutschriften/Stornos bereits mit ihrem
  (negativen) Vorzeichen enthalten.
- **`top-customers`** — die `limit` umsatzstärksten Kunden (netto) im Zeitraum,
  absteigend sortiert.
- **`status`** — Anzahl Rechnungen je effektivem Status (inkl. fällig/überfällig-
  Ableitung) sowie der offene Betrag je Status.
- **`payment-behaviour`** — Ø Tage bis zur Zahlung und Pünktlichkeitsanteil (0–1)
  über als `PAID` abgeschlossene Rechnungen; beide Felder sind `null` ohne
  auswertbare Datengrundlage (keine bezahlte Rechnung bzw. keine mit
  Fälligkeitsdatum).
- **`cash-in`** — Zahlungseingang je Kalendermonat (Europe/Berlin) und Währung, lückenlos:
  `paidCents` (Summe der Zahlungen nach `paidAt`; Gegenbuchungen negativ im Monat der
  Gegenbuchung; Skonto und Verrechnungen mit Gutschriften zählen nicht) und
  `invoicedGrossCents` (festgeschriebene Rechnungen nach Belegdatum, Brutto bzw.
  zahlbarer Betrag, Gutschriften negativ, Entwürfe ausgeschlossen).
- **`quote-outcome`** — Angebotsquote je Währung: `accepted`/`rejected`/`expired`/`open`
  je `{ count, netCents }` (nur `ANGEBOT`, Belegdatum im Zeitraum, ohne Entwurf und
  Storno; ein versendetes Angebot mit abgelaufener Gültigkeit zählt als `expired`) und
  `acceptedPermille` (angenommen ÷ entschieden, ‰, `null` ohne Entscheidung).
- **`top-products`** — Nettoumsatz und Menge (Milli-Einheiten) je Produkt und Währung
  (nur Positionen mit Produktbezug, ohne Entwürfe, Gutschriften/Stornos negativ,
  Schlussrechnungen anteilig zum zahlbaren Betrag), absteigend nach Netto, `limit` je
  Währung.
- **`recurring-run-rate`** — monatlich wiederkehrender Netto-Umsatz je Währung
  (`monthlyNetCents`, `activeCount`) über aktive Abos; Intervalle werden auf einen Monat
  umgerechnet, je Abo einmal kaufmännisch gerundet. Abos mit abgelaufenem Enddatum zählen nicht; ein Abo mit unbekanntem Intervall wird übersprungen und in `skipped` gezählt. Kein Zeitraumparameter.

Währungen werden bei allen vier neuen Typen nie gemischt: je Währung eigene Zeilen.

**CSV (Phase 17c):** `GET /api/v1/Report?type=<typ>&format=csv` (für jeden `type`, Scope `read`) liefert statt JSON `text/csv; charset=utf-8` als Anhang `auswertung-<typ>-<Berliner Datum>.csv` (`src/domain/reporting/csv.ts`): UTF-8 mit BOM, Semikolon, `\r\n`, deutsche Spaltenköpfe je Typ, Geld als `1234,56`, Menge mit drei Nachkommastellen, Textzellen mit führendem `=`, `+`, `-`, `@` oder Tab werden mit `'` entschärft (Formelschutz). `format` ist bei jedem Typ zulässig (nicht in den typabhängigen Parametern), ungültige Werte liefern 400. Die OpenAPI-Spezifikation führt dafür neben `application/json` auch `text/csv`. Dieselbe Tabelle gibt die Oberfläche über die Session-Route `GET /api/reports/<typ>.csv` aus (kein Bearer-Zugriff).

Beispiel:

```bash
curl -s "$BASE/api/v1/Report?type=revenue&months=6" -H "$AUTH"
curl -s "$BASE/api/v1/Report?type=revenue&months=6&format=csv" -H "$AUTH" -o umsatz.csv
```

```json
{
  "data": {
    "objectName": "Report",
    "type": "revenue",
    "rows": [
      { "month": "2026-03", "currency": "EUR", "netCents": 0, "count": 0 },
      { "month": "2026-04", "currency": "EUR", "netCents": 150000, "count": 2 }
    ]
  }
}
```

`type=payment-behaviour` liefert `rows` stets als Ein-Elemente-Array
(`[{ avgDaysToPay, onTimeShare, paidCount }]`) — dieselbe Form wie die anderen drei
Typen, damit Konsumenten nicht zwischen Liste und Einzelobjekt unterscheiden müssen.

### OSS-Schwelle (`GET /api/v1/Report/oss`, Phase 16e)

`GET /api/v1/Report/oss` (Scope `read`) wertet die Bagatellgrenze des § 3c Abs. 4 UStG aus (gleicher Kern wie das MCP-Tool `get_oss_threshold`). Query: `year` (optional, Standard aktuelles Jahr in Berliner Zeit). Antwort `{ data }` mit `thresholdCents` (1.000.000), `warnPercent`, `mode` (`ALL_EU_B2C` | `BY_PRODUCT`), `level` (`OK` | `WARN` | `EXCEEDED`), `previousYearExceeded`, `current` und `previous` (je `year`, `netEurCents`, `percent`, `documentCount`, `skippedWithoutEur`, `byCountry`) sowie `notice` (Orientierungshinweis, keine Steuerberatung). Alle Beträge Integer-Cent.

Weitere Felder: `ossCategory` (`NONE` | `GOODS_DISTANCE` | `ELECTRONIC_SERVICE`) an `Product` (Standard `NONE`) und an Positionen (Lese- und Schreibfeld; ohne Angabe übernimmt eine Position mit `productId` die Kategorie des Produkts als Snapshot, ohne Produkt bleibt sie leer). Die Belegeinstellungen (`/api/settings/documents`) tragen `ossCountMode` (Standard `ALL_EU_B2C`) und `ossWarnPercent` (ganze Zahl 1–99, Standard 80).

### Abo-Positionen (`Recurring`, Phase 18c)

`GET /api/v1/Recurring/{id}` sowie `POST` und `PATCH` liefern zusätzlich `lines` (nach `position` sortiert; die Liste `GET /api/v1/Recurring` enthält sie nicht). Jede Zeile trägt `position`, `lineType` (`ITEM` | `HEADING` | `TEXT` | `SUBTOTAL`), `productId` (nur Snapshot), `description`, `descriptionLong`, `articleNumber`, `quantityMilli`, `unit`, `unitNetPriceCents`, `taxRate`, `taxCategory`, `discountPermille`, `discountCents` und `ossCategory`. Im Request (`POST`, `PATCH`) gelten für `lines` dieselben Zeilenfelder und Regeln wie bei Rechnungen: Überschrift, Textblock und Zwischensumme tragen keine Menge, keinen Preis und keinen Rabatt. Jeder Lauf übernimmt die Zeilen in den Rechnungsentwurf.

## Weitere Ressourcen

`Contact`, `ContactAddress`, `ContactPerson`, `Product`, `Quote`,
`OrderConfirmation`, `DeliveryNote`, `Invoice`, `Payment`, `Dunning`, `Attachment`,
`EmailLog`, `PaymentMethod`, `TextTemplate`, `EmailTemplate`, `Recurring`,
`Settings`, `BaseInterestRate`, `ApiKey`, `Webhook`, `Layout`, `ApiRequestLog`, `Tag`,
`DocumentTemplate` — vollständige Liste mit Feldern, Filtern (`embed=`,
Statusfilter, Datumsbereiche) und Beispielen: `GET /api/docs`.

`BaseInterestRate` (Phase 14a) — Basiszinssatz-Historie (§ 288 Abs. 1 Satz 2 BGB,
Bekanntgabe der Deutschen Bundesbank zum 01.01./01.07.), seit Phase 14a die
alleinige Quelle der Verzugszinsberechnung (ersetzt das einzelne Feld
`DunningSettings.baseInterestRateBp`). `GET /api/v1/BaseInterestRate` (Scope
`admin`, keine Paginierung — die Historie wächst höchstens zweimal jährlich)
liefert alle Einträge aufsteigend nach `validFrom`. `POST
/api/v1/BaseInterestRate` (Scope `admin`, Body
`{"validFrom":"2026-07-01","rateBp":342,"source":"Bundesbank"}` → `201`) legt
einen Eintrag an oder überschreibt den bestehenden Eintrag zu genau diesem
`validFrom` (Upsert, `rateBp` in Basispunkten, 127 = 1,27 %). `DELETE
/api/v1/BaseInterestRate/{id}` (Scope `admin`) löscht einen Eintrag — der
letzte verbleibende Eintrag einer Organisation ist geschützt (`400
VALIDATION`, die Verzugszinsberechnung braucht mindestens einen Satz).

`Tag` (Phase 13d) — Ordnungsmerkmal über Belegen (`INVOICE`/`QUOTE`/
`DELIVERY_NOTE`), reine Metadaten ohne GoBD-Bezug: setz-/entfernbar auch an
festgeschriebenen Rechnungen. `GET /api/v1/Tag` (Scope `read`) und `POST
/api/v1/Tag` (Scope `write`, Body `{"name":"Wartung","color":"slate"}` →
`201`) sowie `GET` (Scope `read`)/`PATCH`/`DELETE /api/v1/Tag/{id}` (beide
Scope `write`) decken Anlegen/Ändern/Löschen ab (`DELETE` ist bodylos und
entfernt dabei alle Zuordnungen des Tags, `200` mit `{data:{deleted:true}}`).
Zuordnen/Entfernen an einem konkreten Beleg läuft bewusst über zwei eigene,
idempotente **POST**-Aktionsrouten (Scope `write`) statt `DELETE` mit Body (die
API akzeptiert bei `DELETE` grundsätzlich keinen Request-Body): `POST
/api/v1/Tag/{id}/assign` (Body `{"docType":"INVOICE","docId":"RE-2026-00342"}`
→ `{created}`) und `POST /api/v1/Tag/{id}/unassign` (derselbe Body → `{removed}`)
— **beide `assign` und `unassign` sind `POST`**, kein `DELETE`; ein erneuter
Aufruf mit derselben Zuordnung ist kein Fehler.

`DocumentTemplate` (Phase 13d) — wiederverwendbare Belegvorlage (Positionen +
Kopf-Metadaten, ohne Belegnummer/Datum/Snapshots/interne Notizen, §48).
`GET /api/v1/DocumentTemplate` (Scope `read`, Filter `docType`) und `POST
/api/v1/DocumentTemplate` (Scope `write`, Body
`{"name":"Wartung monatlich","docType":"INVOICE","customerId":"...","payload":{"lines":[...]}}`)
sowie `GET` (Scope `read`)/`PATCH`/`DELETE /api/v1/DocumentTemplate/{id}`
(beide Scope `write`; `PATCH` deckt Name/Kunde/Payload ab, `docType`/`kind`
bleiben fix) verwalten die Vorlage selbst; `payload` kommt immer als geparstes
Objekt zurück, nie als roher JSON-String. `POST
/api/v1/DocumentTemplate/{id}/apply` (Scope `write`, Body `{"customerId":"..."}`
optional → `201`) erzeugt daraus einen neuen Belegentwurf über dieselbe
Domain-Funktion wie die UI (gleiche Steuersatz-/Kundenprüfung, `404 NOT_FOUND`
bei unbekanntem Kunden, `409 CONFLICT` ohne auflösbaren Kunden) und liefert nur
ein kleines Verweisobjekt (`{objectName:"DocumentTemplateApplication",
docType,id}`) — die neue Ressource selbst danach über `GET
/api/v1/{Invoice,Quote,DeliveryNote}/{id}` laden.

`GET /api/v1/Layout` (Scope `read`) liefert die sieben festen PDF-Layouts (`id`,
`name`, `description`, `thumbnailUrl`) — keine Paginierung, kein POST/PATCH (feste
Liste, keine DB-Tabelle). Auswahl je Organisation/Belegtyp über `PATCH
/api/v1/Settings` (`branding.layoutId`/`branding.layoutByType`). Eine Beleg-
individuelle Layout-Überschreibung ist seit der Fix-Welle (Phase 11b) auch über
`/api/v1` erreichbar: `GET`/`PATCH /api/v1/{Invoice,Quote,DeliveryNote}/{id}/print-
options` (Scope `read`/`write`) liefert die effektiven Druckoptionen (globale
Einstellungen verschmolzen mit einer etwaigen Beleg-Überschreibung) bzw. setzt die
Überschreibung als Ganzes (`printOptionsOverrideSchema`, inkl. optionalem
`layoutId`) — dieselbe Domain-Funktion (`setPrintOptions`) wie MCP
(`set_print_options`) und UI, nur solange der Beleg im Entwurf (`DRAFT`) ist (409
sonst). `Quote/{id}/print-options` gilt nur für `kind=ANGEBOT` — Auftragsbestätigung/
Proforma haben keinen eigenen `print-options`-Endpunkt.

**Layout-Designs (Phase 16g).** `GET /api/v1/Layout` liefert zusätzlich zu den festen Layouts die Designs der Organisation (`id`, `ref` = `design:<id>`, `name`, `baseLayoutId`, `currentVersion`, `archived`; `?includeArchived=true`). `POST /api/v1/Layout` legt ein Design an (`name`, optional `baseLayoutId` oder `config`), `GET`/`PUT /api/v1/Layout/{id}` liest bzw. speichert (eine Speicherung mit geänderter Konfiguration erzeugt eine neue unveränderliche Version, `archived` archiviert/reaktiviert), `GET /api/v1/Layout/{id}/versions` listet die Versionen, `POST /api/v1/Layout/{id}/preview` rendert ein PDF-Vorschaubild mit Wasserzeichen (`config` oder `version`, optional Entwurf; 30 Aufrufe/min je Schlüssel). Scope `read` für alle Lesezugriffe und die Vorschau. Fehler: 400 `VALIDATION` (Konfiguration oder Anschriftfenster), 404 für fremde Organisation, 409 bei Namenskollision oder wenn ein zugeordnetes Design archiviert werden soll. Die Zuordnung läuft über `PATCH /api/v1/Settings` mit `branding.layoutId`/`branding.layoutByType` und dem Wert `design:<id>` (fremdes, archiviertes oder unbekanntes Design: 400); die eingefrorene Version eines Belegs steht nicht in der API.

`GET`/`PATCH /api/v1/Settings` (Scope `admin`) bündelt vier Fragmente unter je
einem Schlüssel: `documents` (u. a. `taxRates` — die org-eigene Liste
freigegebener Steuersätze, 1–10 ganze Prozentwerte 0–100, Default `[19, 7, 0]`,
Phase 12c), `branding` (u. a. `appName`/`appShortName`/`faviconPath`/
`appLogoPath` — Marke/White-Label, Phase 12c; `appName`/`appShortName` sind per
`PATCH` schreibbar, `faviconPath`/`appLogoPath` nur lesbar — Datei-Upload läuft
ausschließlich über die Session-Route `/api/settings/branding/upload`, nicht
über `/api/v1`), `print` und `dunning` (Auto-Erstellung/-Versand, Karenztage).
Ein Versuch, eine Rechnung/ein Angebot/einen Lieferschein/ein Produkt mit einem
Steuersatz zu speichern, der **nicht** in `documents.taxRates` steht (und auch
nicht bereits auf dem betroffenen Beleg gespeichert war), liefert `409
CONFLICT` — dieselbe Regel wie in UI und MCP, durchgesetzt in den
Domain-Kernen, kein API-eigener Bypass.

**Altschreibweg `dunning.baseInterestRateBp`/`dunning.baseRateValidFrom`**
(Phase 14a, R6): seit Phase 14a liest die Verzugszinsberechnung ausschließlich
die Basiszinssatz-Historie (`BaseInterestRate`, siehe oben) — die beiden
gleichnamigen `DunningSettings`-Felder bleiben aus Kompatibilitätsgründen
bestehen und lesbar, werden aber von keiner Berechnung mehr verwendet. Ein
`PATCH /api/v1/Settings` mit `dunning.baseInterestRateBp` (optional zusammen
mit `dunning.baseRateValidFrom`) wird deshalb zusätzlich als Upsert eines
`BaseInterestRate`-Eintrags interpretiert (`validFrom = baseRateValidFrom ??
heute`) — eine Quelle der Wahrheit, kein API-Bruch. Für neue Integrationen:
direkt `POST /api/v1/BaseInterestRate` verwenden.

## Webhooks

Event-getriebene Zustellung (Outbox, HMAC-Signatur, Retry) über
`/api/v1/Webhook` (Scope `admin`) — Ereignisse, Payload-Form, Signaturprüfung
(Node/PHP), Retry-Zeitplan und SSRF-Regeln: siehe [WEBHOOKS.md](WEBHOOKS.md).

## Währung (`currency`)

`currency` ist ein optionaler ISO-4217-Code aus drei Großbuchstaben (z. B. `USD`; Kleinbuchstaben werden zu Großbuchstaben normalisiert) an Rechnung, Dokument (Angebot/AB/Proforma) und Abo. Ohne Angabe gilt die Kette Kunde (`defaultCurrency`) > Einstellung > `EUR`. Alle Beträge des Belegs sind in dieser Währung (Integer-Cent); Fremdwährungsbelege haben keinen GiroCode.

`language` (`de` | `en`) ist optional an Rechnung, Dokument, Lieferschein und Abo und steht in allen Antworten (auch an E-Mail- und Textvorlagen); ohne Angabe gilt die Kundensprache, sonst `de`. Die Sprache wird am Beleg eingefroren und steuert PDF, E-Rechnungs-Hinweise und Mails. `fxOverrideRate` (Dezimalzahl, Einheiten Fremdwährung je 1 EUR, höchstens 6 Nachkommastellen, höchstens 2000) überschreibt die Kurstabelle beim Festschreiben, bei Storno und Teilgutschrift (Reihenfolge: Originalkurs > Override > Tabelle).

### Wechselkurse (`/api/v1/ExchangeRate`)

| Methode, Pfad | Scope | Zweck |
|---|---|---|
| `GET /api/v1/ExchangeRate?currency=USD&date=2026-11-12` | read | Kurs, der für Währung und Stichtag gemäß Kursquelle der Organisation gilt (`fxRateSource`: `BMF_MONTHLY` Monatsdurchschnitt, Standard; `ECB_DAILY` Tageskurs nur mit Gestattung des Finanzamts). Fehlt der Monatskurs, gilt der Vormonat (Antwort nennt das Kursdatum). 404 ohne Kurs. |
| `POST /api/v1/ExchangeRate` | admin | Kurs pflegen (Upsert): `source` `MONTHLY` (rateDate = Monatserster) oder `ECB` (Tageskurs), `currency`, `rateDate`, `rate`, `note`. Wirkt nur auf danach festgeschriebene Belege. |
| `POST /api/v1/ExchangeRate/refresh` | admin | EZB-Referenzkurse sofort abrufen und Monatsmittel (nur bei mindestens 15 Tageskursen) berechnen; 409 `reason=disabled` bei `FX_AUTO_FETCH=0`, 502 `reason=fetch_failed`. |

Die Kursquelle (`fxRateSource`) steht in den Belegeinstellungen (`/api/settings/documents`). Rechnungen liefern `fxRate`, `fxRateDate`, `fxRateSource`, `fxOverrideRate`, `netTotalEurCents`, `taxTotalEurCents` (befüllt ab Festschreiben bei Fremdwährung) und `language`.

## Storno (`POST /api/v1/Invoice/{id}/cancel`)

Optionaler JSON-Body `{ "reason": "…" }` (max. 500 Zeichen): der Stornogrund steht als
„Grund: …“ in den Notizen der Storno-Gutschrift und im ChangeLog. Gibt es bereits
festgeschriebene Teilgutschriften, erstattet das Storno nur den Rest (Summe aller
Gutschriften = Rechnungsbetrag); ist die Rechnung vollständig gutgeschrieben, antwortet
die API mit 409. Eine Abschlagsrechnung, die in einer nicht stornierten Schlussrechnung
verrechnet ist, lässt sich nicht stornieren (409). Die Storno-Gutschrift trägt keine
Zahlungsbedingungen des Originals.

## Gegenbuchung, Archiv, Prüfung, Health (Phase 16a)

| Route | Scope | Zweck |
|---|---|---|
| `POST /api/v1/Payment/{id}/reverse` | `write` | Zahlung per Gegenbuchung korrigieren. Body `{ "reason": "…" (3–500 Zeichen), "amountCents": 1000 (optional, positiv; Standard: noch nicht gegengebuchter Rest) }`, Antwort die Gegenbuchung (`kind: "REVERSAL"`, `reversesPaymentId`, negativer Betrag). Zahlungen werden nie gelöscht. 409 bei Überschreitung des Restbetrags. Löst den Webhook `payment.reversed` aus. |
| `GET /api/v1/Invoice/{id}/archive` | `read` | Archivstand der Rechnung (Dateien mit SHA-256, Quelle, Zeitpunkt); archiviert nicht selbst. |
| `GET /api/v1/AuditChain` | `read` | Letzte Kettenprüfungen (`limit`). |
| `POST /api/v1/AuditChain/verify` | `admin` | Hash-Kette sofort prüfen, Ergebnis protokollieren, bei Bruch alarmieren. |
| `GET /api/v1/AuditExport?from=YYYY-MM-DD&to=YYYY-MM-DD` | `admin` | Prüfer-Export (§ 147 Abs. 6 AO) als ZIP; höchstens 3 Jahre, 20.000 Belege (sonst 413). 409, solange im Zeitraum mehr als 200 Belege noch nicht archiviert sind (Backfill abwarten oder Zeitraum verkleinern). CSV unverändert — nicht in einer Tabellenkalkulation mit Formelauswertung öffnen. |
| `GET /api/v1/System/health` | `admin` | Datenbank, Scheduler-Jobs, Belegarchiv, Kettenprüfung, letzte Sicherung. |
| `GET /api/health` | öffentlich | `{"status":"ok"}` bzw. 503; kein Rate-Limit, das Datenbank-Ergebnis wird serverseitig 5 s zwischengespeichert (Antwort `Cache-Control: no-store`). |

Das PDF/XML einer archivierten Rechnung (`GET /api/v1/Invoice/{id}/pdf`) liefert bei jedem Abruf dieselben Bytes (Stand der ersten Ausgabe).

## Postversand (Phase 16d)

Rechnungen (`docType` `INVOICE`, alle Rechnungstypen) und Mahnungen (`DUNNING`) lassen sich über den Briefdienst versenden. Zugangsdaten, Schalter (`enabled`, `mode`, `autoDunningPost`) und Budget gibt es **nur in der Oberfläche**; die API liest sie und setzt nur Druckoptionen.

| Route | Scope | Zweck |
|---|---|---|
| `GET /api/v1/Settings/postal` | `admin` | Einstellungen lesen (`hasApiKey`, `apiKeyLast4`, wirksamer Modus; nie der Schlüssel) |
| `PUT /api/v1/Settings/postal` | `admin` | nur Druckoptionen (`color`, `duplex`, `shipping`, `registeredDefault`); andere Felder → 400 |
| `POST /api/v1/Settings/postal/test` | `admin` | Verbindung prüfen (nur Guthabenabfrage) |
| `GET /api/v1/PostalPrice` | `write` | Preis eines Briefs (`pages`, `color`, `duplex`, `shipping`, `registered`); nur bei eingeschaltetem Postversand |
| `POST /api/v1/PostalQuote` | `write` | Angebot je Beleg (`items[]`): Anschrift, Seiten, Preis, `pdfSha256`, Probleme; versendet nichts |
| `POST /api/v1/PostalJob` | `write` | Versand bzw. Trockenlauf (`items[]` mit `expectedPriceCents`, `pdfSha256` aus dem Angebot, `confirm: true`) |
| `GET /api/v1/PostalJob`, `GET /api/v1/PostalJob/{id}` | `read` | Aufträge (Filter `status`, `docType`, `docId`, `mode`) bzw. Auftrag mit Ereignissen |
| `DELETE /api/v1/PostalJob/{id}?confirm=true` | `write` | Storno (nur binnen 15 Minuten, nur Warteschlange) |
| `POST /api/v1/PostalJob/{id}/resolve` | `admin` | unklaren Auftrag (`UNKNOWN`) manuell abschließen: `{ "outcome": "SENT" \| "NOT_SENT", "note": "…" }` (Begründung 3–500 Zeichen) |

- **`POST /api/v1/PostalJob` verlangt den Header `Idempotency-Key`** (sonst 400) und `confirm: true`. Preis und Prüfsumme stammen aus dem Angebot; weichen sie ab (`PRICE_CHANGED`, `PDF_CHANGED`, `PRICE_UNAVAILABLE`) und sind **alle** Positionen davon betroffen, antwortet die API `409` mit `reason` und `details.results`. Sonst `200` mit einem Ergebnis je Position (`status` ein Auftragsstatus oder `REJECTED` mit `code` wie `ALREADY_SENT`, `BUDGET`, `NO_ADDRESS`, `NOT_ALLOWED`); ein abgelehnter Beleg bricht die übrigen nicht ab.
- **Fehler:** `409` mit `reason` `disabled`, `not_configured`, `key_unreadable`, `network_disabled` (Notschalter `POSTAL_NETWORK=0`) bzw. dem Konfliktcode; `502` mit `reason` `provider_auth`, `provider_rejected`, `provider_unavailable` (feste Texte, nie Anbietertext).
- **Kontingent:** zusätzlich zum allgemeinen Limit höchstens 30 Postaktionen (Angebot, Preis, Versand, Storno) je Minute und Organisation, gemeinsam für REST und MCP (`429`).
- Im Modus Testmodus landet der Auftrag in der Postbox des Briefdienstes und ist dort manuell versendbar (keine Sandbox); ein aktiver Testauftrag sperrt den Live-Versand desselben Belegs (`ALREADY_SENT`).
- Webhook-Ereignisse: `postal.submitted`, `postal.done`, `postal.failed`, `postal.cancelled` (siehe [WEBHOOKS.md](WEBHOOKS.md)).

## CSV-Export und -Import (Phase 18b)

**Export:** Die Listen `Invoice`, `Quote`, `OrderConfirmation`, `DeliveryNote`, `Contact` und `Product` (`GET /api/v1/<Ressource>?format=csv`, Scope `read`) liefern dieselbe Auswahl wie die JSON-Liste mit denselben Filtern, aber ohne Paginierung (`limit`, `offset`, `embed` entfallen) als `text/csv` (Semikolon, UTF-8 mit BOM). Höchstens 20.000 Zeilen, darüber `413`; 30 Exporte je Minute und Organisation (`429`). `format` darf nur `json` oder `csv` sein (sonst `400`).

**Import:** `POST /api/v1/Contact/import` und `POST /api/v1/Product/import` (Scope `write`), JSON-Body `{ "csv": "<Text>", "fileName"?, "dryRun"?, "expectedHash"?, "allowRepeat"? }`:
- `dryRun` ist standardmäßig `true` und liefert nur die Vorschau (`preview` mit `fileHash`, `totalRows`, `validRows`, `errorCount`, `errors[]` je Zeile/Spalte, `ignoredColumns`; nie Beispielzeilen).
- `dryRun: false` legt alle Zeilen an oder keine (nur Anlage, kein Update). Pflicht: Header `Idempotency-Key` und `expectedHash` (der `fileHash` der Vorschau), sonst `400`.
- `csv` höchstens 2 MB, Body höchstens 3 MB, 2.000 Datenzeilen.
- Antworten: `200` Vorschau, `201` angelegt (`created`), `400` ungültige Eingabe, `409` Datei geändert seit der Vorschau oder bereits importiert (`allowRepeat: true` erlaubt den Wiederholungsimport innerhalb von 24 Stunden bewusst), `413` zu groß, `422` Datei enthält Fehler (`details.errors`), `429` Rate-Limit (Vorschau 20, Import 5 je Minute und Organisation).
- Das Anfrageprotokoll schwärzt das Feld `csv`.

```bash
CSV=$'Name;Straße;PLZ;Ort;E-Mail\r\nMuster GmbH;Beispielweg 1;12345;Musterstadt;info@example.org\r\n'
curl -s -X POST https://rechnung.example.org/api/v1/Contact/import \
  -H "Authorization: Bearer $OIG_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --arg csv "$CSV" '{csv: $csv}')"      # Vorschau
curl -s -X POST https://rechnung.example.org/api/v1/Contact/import \
  -H "Authorization: Bearer $OIG_KEY" -H "Idempotency-Key: import-001" -H "Content-Type: application/json" \
  -d "$(jq -n --arg csv "$CSV" --arg h "<fileHash der Vorschau>" '{csv: $csv, dryRun: false, expectedHash: $h}')"
```

## Fehlende Endpunkte / Grenzen (siehe auch [LIMITATIONEN.md](LIMITATIONEN.md))

- Die meisten Aktions-Endpunkte (`/finalize`, `/cancel`, `/credit`, `/convert`,
  `/status`, `/duplicate`, …) liefern die **vollständige, aktualisierte Ressource**
  (nicht nur ein Teilobjekt) — Ausnahmen mit einem kleinen, expliziten
  Antwortobjekt: `/send` (`{emailLogId, status}`), `/payment`
  (`{payment, invoice}` — `payment` ist trotz des Feldnamens die aktualisierte
  Rechnung, siehe `/api/docs`), `/dunning` (`{dunning}`), `/share-link`
  (`{url, token?, expiresAt}`). Datei-Endpunkte (`/pdf`, `/xrechnung`,
  `/zugferd`) bleiben binär.
- `DeliveryNote`: `PATCH /api/v1/DeliveryNote/{id}` ändert nur Entwürfe (Status `DRAFT`, anzulegen mit `draft: true` beim `POST`); `deliveryDate`/`shippingDate` lassen sich mit `null` leeren, ein erstellter Lieferschein liefert 409, ein Body ohne Änderung (z. B. `{}`) 400. Statusänderungen laufen über `POST .../status`.
- `Layout` (Phase 11b) selbst ist nur lesbar (`GET`, feste Liste, keine DB-Tabelle) —
  eine Beleg-individuelle Layout-Überschreibung setzt sich stattdessen über `PATCH
  /api/v1/{Invoice,Quote,DeliveryNote}/{id}/print-options` (siehe oben).
- Multi-Tenant-Rollen gibt es nicht — ein API-Schlüssel gehört zu genau einer
  Organisation, „Berechtigungen" bedeuten hier ausschließlich Scopes.
- `POST /api/pdf/preview` (Beleg-Editor, Phase 11c) ist **keine** `/api/v1`-Ressource:
  eine Session-Route (Browser-Login, kein Bearer-Token) zum Rendern eines
  ungespeicherten Editor-Entwurfs (`{kind, payload, layoutId?}`) — ohne
  Nummernkreis/`ChangeLog`/DB-Schreibzugriff, Belegnummer „ENTWURF", Wasserzeichen
  „VORSCHAU". Für einen bereits gespeicherten Beleg liefert stattdessen `GET
  /api/v1/Invoice/{id}/pdf` (Scope `read`) das PDF; `Quote`/`DeliveryNote` haben
  keinen `/pdf`-Endpunkt unter `/api/v1` (nur die Session-Routen
  `/api/documents/[id]/pdf` bzw. `/api/delivery-notes/[id]/pdf`).
