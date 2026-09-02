# Lastenheft Auftragsverwaltung · Rechnungswesen · Mahnwesen

Stand: 2026-09-02. Massgebliche Anforderung des Betreibers, ersetzt die Paketierung A-H im Backlog.

---


## 1. ZUERST BESTANDSAUFNAHME

Bevor du Code änderst:

1. Analysiere das komplette Repository.
2. Prüfe insbesondere:

   * Prisma-Schemas und Migrationen
   * Domain-Services
   * API-Routen
   * UI
   * PDF-Erzeugung
   * E-Rechnungslogik
   * Mahnwesen
   * Payment-Handling
   * Quotes / Angebote
   * Order Confirmations
   * Recurring Invoices
   * Credit Notes
   * Settings
   * MCP-Server
   * Tests
   * COMPLIANCE.md
   * ARCHITEKTUR.md
   * LIMITATIONEN.md
3. Erstelle intern eine Gap-Matrix:

   * bereits vollständig vorhanden
   * teilweise vorhanden
   * fehlt
   * vorhandene Implementierung muss erweitert werden
4. Implementiere KEINE bestehende Funktion doppelt.
5. Bestehende Architektur und Compliance-Regeln müssen erhalten bleiben.
6. GoBD-Unveränderbarkeit darf niemals zugunsten einer bequemeren UI umgangen werden.
7. Bestehende Tests dürfen nicht gebrochen werden.

Danach die folgenden Funktionen umsetzen.

---

# PRIORITÄT P0 – GRUNDLEGENDER WORKFLOW

## 2. EINHEITLICHES DOKUMENTSYSTEM

Die Anwendung benötigt einen echten zusammenhängenden Auftragsworkflow.

Unterstützte Dokumenttypen:

* Angebot
* Auftragsbestätigung
* Lieferschein
* Rechnung
* Abschlagsrechnung
* Teilrechnung
* Schlussrechnung
* Pro-forma-Rechnung
* Zahlungserinnerung
* Mahnung
* Stornorechnung
* Gutschrift / Rechnungskorrektur

Alle Dokumente müssen miteinander verknüpft werden können.

Beispiel:

Angebot
→ Auftragsbestätigung
→ Lieferschein
→ Rechnung
→ Zahlung
→ erledigt

oder:

Angebot
→ Abschlagsrechnung 30 %
→ Abschlagsrechnung 30 %
→ Schlussrechnung 40 %

oder:

Angebot
→ Teilrechnung
→ Teilrechnung
→ Schlussrechnung

Die komplette Dokumentkette muss in jedem Dokument sichtbar sein.

Beispiel:

Dokumentverlauf

ANG-2026-00123
↓
AB-2026-00118
↓
LS-2026-00104
↓
RE-2026-00384
↓
Zahlung 1.190,00 €

Implementiere dafür möglichst eine generische DocumentRelation-/DocumentChain-Struktur statt immer neue Spezialfelder anzulegen.

---

# 3. ANGEBOTSVERWALTUNG

Bestehende Angebotsfunktion prüfen und erweitern.

Angebote benötigen:

* Entwurf
* offen / versendet
* angenommen
* abgelehnt
* abgelaufen
* teilberechnet
* vollständig berechnet

Felder:

* Angebotsnummer
* Kunde
* Rechnungs-/Kontaktadresse
* Ansprechpartner
* Angebotsdatum
* gültig bis
* Betreff
* Kopftext
* Positionen
* Fußtext
* Lieferbedingungen
* Zahlungsbedingungen
* interne Notiz
* Kundenreferenz
* Währung
* Netto/Brutto
* Rabatt
* Aufschlag

Aktionen:

* bearbeiten
* duplizieren
* PDF erzeugen
* herunterladen
* per E-Mail senden
* erneut senden
* als angenommen markieren
* als abgelehnt markieren
* Auftragsbestätigung erzeugen
* Lieferschein erzeugen
* Rechnung erzeugen
* Teilrechnung erzeugen
* Abschlagsrechnung erzeugen
* archivieren

Beim Konvertieren müssen relevante Daten übernommen werden.

---

# 4. ONLINE-ANGEBOTSANNAHME

Angebote sollen optional einen sicheren öffentlichen Link enthalten.

Beispiel:

https://invoice.example.com/offer/<secure-token>

Darüber kann der Kunde:

* Angebot ansehen
* PDF herunterladen
* Angebot annehmen
* Angebot ablehnen

Optional:

* Name des Bestätigenden
* E-Mail-Adresse
* Kommentar
* Timestamp
* IP nur wenn datenschutzrechtlich sinnvoll und konfiguriert

Der Link benötigt:

* kryptografisch sicheren Token
* Ablaufdatum
* Widerrufsmöglichkeit
* Rate Limiting

Beim Annehmen:

* Status → ACCEPTED
* Event im Audit/Activity Log
* Benutzer informieren

Optionale Einstellung:

"Bei Angebotsannahme automatisch Rechnung erzeugen"

oder

"Bei Angebotsannahme automatisch Auftragsbestätigung erzeugen"

---

# 5. AUFTRAGSBESTÄTIGUNGEN

Bestehende Funktion erweitern.

Status:

* Entwurf
* versendet
* teilweise berechnet
* berechnet
* storniert

Aus Angebot erzeugbar.

Aus Auftragsbestätigung erzeugbar:

* Lieferschein
* Rechnung
* Abschlagsrechnung
* Teilrechnung
* Schlussrechnung

Eigene Nummernkreise.

Eigene Standardtexte für:

* Kopftext
* Fußtext
* Lieferbedingungen
* Zahlungsbedingungen
* E-Mail

---

# 6. LIEFERSCHEINE

Falls noch nicht vollständig vorhanden: neu implementieren.

Lieferschein muss erzeugbar sein aus:

* Angebot
* Auftragsbestätigung
* Rechnung
* manuell

Daten übernehmen:

* Kunde
* Lieferadresse
* Positionen
* Mengen
* Artikelnummer
* Beschreibung

Konfigurierbar:

* Preise anzeigen ja/nein
* Umsatzsteuer anzeigen ja/nein
* Artikelnummer anzeigen
* Beschreibung anzeigen
* Lieferdatum
* Versanddatum

Status:

* Entwurf
* erstellt
* versendet
* geliefert
* berechnet
* storniert

Teil-Lieferscheine unterstützen.

Beispiel:

Bestellung 10 Stück

LS1 → 4 Stück
LS2 → 6 Stück

Danach Bestellung vollständig geliefert.

---

# PRIORITÄT P0 – RECHNUNGSFUNKTIONEN

# 7. RECHNUNGSEDITOR ERWEITERN

Der Rechnungseditor soll deutlich komfortabler werden.

## Kopfdaten

* Kunde
* Rechnungsadresse
* alternative Adresse
* Ansprechpartner
* Rechnungsdatum
* Lieferdatum
* Leistungszeitraum von/bis
* Fälligkeitsdatum
* Zahlungsziel
* Kundenreferenz
* Bestellnummer
* Leitweg-ID
* interne Referenz
* Betreff
* Währung

## Positionen

Jede Position:

* Artikelnummer
* Bezeichnung
* ausführliche Beschreibung
* Menge
* Einheit
* Einzelpreis
* Netto/Brutto
* Steuersatz
* Rabatt
* Gesamtsumme

Rabatt:

* Prozent
* Festbetrag

Positionen per Drag & Drop sortieren.

Position duplizieren.

Produkt aus Produktkatalog auswählen.

Freie Position erstellen.

Direkt während Rechnungsbearbeitung neues Produkt anlegen.

---

# 8. POSITIONSBLÖCKE UND ÜBERSCHRIFTEN

Positionen sollen gruppierbar sein.

Beispiel:

### Einrichtung

1x Installation
3x Konfiguration

### Hosting

12x Webhosting

Implementiere dafür echte Section-/Heading-Positionen und NICHT den Workaround "Menge 0 / Preis 0".

Unterstützen:

* Überschrift
* Beschreibung/Textblock
* normale Position
* Zwischensumme

---

# 9. FORMATIERTE POSITIONSTEXTE

Positionsbeschreibungen benötigen einfache Formatierung:

* fett
* kursiv
* unterstrichen
* Bullet-Liste
* nummerierte Liste
* Zeilenumbrüche
* Links

Kein ungefiltertes HTML speichern/rendern.

Verwende eine sichere strukturierte Rich-Text-Lösung oder sanitisiertes HTML.

PDF-Ausgabe muss identisch bzw. möglichst konsistent dargestellt werden.

---

# 10. GESAMTRABATT UND AUFSCHLAG

Zusätzlich zu Positionsrabatten:

Gesamtrabatt:

* Prozent
* Festbetrag

Gesamtaufschlag:

* Prozent
* Festbetrag

Korrekte steuerliche Aufteilung bei mehreren Umsatzsteuersätzen sicherstellen.

Beispiel:

100 € mit 19 %
100 € mit 7 %

10 % Gesamtrabatt

Rabatt muss proportional und steuerlich korrekt aufgeteilt werden.

Tests hierfür erstellen.

---

# 11. SKONTO

Skonto vollständig modellieren.

Nicht nur Freitext.

Felder:

* Skonto %
* Skontofrist Tage
* optional zweites Skontoziel

Beispiel:

2 % innerhalb 7 Tagen
Zahlbar netto innerhalb 14 Tagen

Ausgabe im PDF.

Strukturierte Übernahme in XRechnung/ZUGFeRD soweit EN16931-konform möglich.

Beim Zahlungseingang:

* Skonto automatisch erkennen/anbieten
* Restforderung entsprechend schließen
* Payment als Skonto markieren

---

# 12. ZAHLUNGSMETHODEN

Einstellungen → Zahlungsmethoden.

Standard:

* Überweisung
* Barzahlung
* EC-/Debitkarte
* Kreditkarte
* PayPal
* SEPA-Lastschrift
* bereits bezahlt
* sonstige

Eigene Zahlungsmethoden anlegbar.

Pro Zahlungsmethode:

* Name
* Beschreibung
* Zahlungsziel
* Text für Rechnung
* optional Bankkonto

Zahlungsmethode als Kunden-Default speicherbar.

---

# 13. TEILRECHNUNGEN

Aus Angebot/Auftragsbestätigung/Lieferschein:

"Teilrechnung erstellen"

Auswahl:

* Prozentsatz
* Festbetrag netto
* Festbetrag brutto
* bestimmte Positionen
* Teilmengen einzelner Positionen

System muss speichern, welcher Anteil bereits berechnet wurde.

Status Quelldokument:

* unberechnet
* teilberechnet
* vollständig berechnet

---

# 14. ABSCHLAGSRECHNUNGEN

Unterstützen:

* Prozent des Gesamtauftrags
* fester Betrag
* mehrere Abschlagsrechnungen

Beispiel:

Auftrag 10.000 €

1. Abschlag 30 %
2. Abschlag 30 %
   Schlussrechnung Rest

Abschlagsrechnungen müssen miteinander und mit dem Ursprungsauftrag verknüpft sein.

---

# 15. SCHLUSSRECHNUNG

Schlussrechnung muss aus ursprünglichem Angebot/Auftrag erzeugbar sein.

Darstellung:

Gesamtleistung
10.000 €

abzüglich Abschlagsrechnung RE-001
-3.000 €

abzüglich Abschlagsrechnung RE-002
-3.000 €

Restbetrag
4.000 €

Bereits erfolgte Zahlungen berücksichtigen.

Steuerliche Behandlung sauber testen.

---

# 16. STORNO / GUTSCHRIFT / KORREKTUR

Bestehende Logik beibehalten und UI verbessern.

Für festgeschriebene Rechnungen niemals direkte Änderungen ermöglichen.

Aktionen:

* vollständig stornieren
* Teilgutschrift
* Rechnungskorrektur
* Gutschrift
* neue Rechnung auf Grundlage dieser Rechnung

Im UI eindeutig erklären und Dokumentketten anzeigen.

---

# PRIORITÄT P0 – TEXTVORLAGEN UND E-MAIL

# 17. ZENTRALE TEXTVORLAGEN

Einstellungen → Textvorlagen

Typ:

* Dokumenttext
* E-Mail
* Signatur

Verwendbar für:

* Angebot
* Auftragsbestätigung
* Lieferschein
* Rechnung
* Abschlagsrechnung
* Teilrechnung
* Schlussrechnung
* Gutschrift
* Zahlungserinnerung
* Mahnung

Position:

* Kopftext
* Fußtext
* E-Mail-Betreff
* E-Mail-Nachricht
* Signatur

Mehrere Vorlagen pro Dokumenttyp erlauben.

Eine Vorlage kann als Standard markiert werden.

---

# 18. PLATZHALTERSYSTEM

Ein zentrales Template-System entwickeln.

Beispiele:

{{customer.name}}
{{customer.firstName}}
{{customer.lastName}}
{{customer.number}}

{{document.type}}
{{document.number}}
{{document.date}}
{{document.dueDate}}
{{document.total}}
{{document.netTotal}}
{{document.taxTotal}}

{{invoice.number}}
{{invoice.total}}
{{invoice.dueDate}}

{{offer.number}}
{{offer.validUntil}}

{{company.name}}
{{company.email}}
{{company.phone}}

{{contact.name}}

{{payment.iban}}
{{payment.bic}}

Auch Custom Fields unterstützen:

{{customer.customField.xyz}}

Template-Preview anbieten.

Fehlende Platzhalter dürfen die Dokumenterstellung nicht crashen.

---

# 19. STANDARD-E-MAIL-TEXTE

Beim ersten Setup sinnvolle deutsche Standardvorlagen erzeugen.

KEINE Texte anderer Software kopieren.

Eigene neutrale Texte erstellen.

## Angebot

Betreff:

Angebot {{document.number}} von {{company.name}}

Nachricht sinngemäß:

Guten Tag,

anbei erhalten Sie unser Angebot {{document.number}}.

Das Angebot ist bis zum {{offer.validUntil}} gültig.

Für Rückfragen stehen wir gerne zur Verfügung.

Freundliche Grüße
{{company.name}}

## Auftragsbestätigung

Betreff:

Auftragsbestätigung {{document.number}}

Text:

Vielen Dank für Ihren Auftrag.

Anbei erhalten Sie die Auftragsbestätigung {{document.number}}.

## Lieferschein

Betreff:

Lieferschein {{document.number}}

Text:

Anbei erhalten Sie den Lieferschein zu Ihrer Lieferung.

## Rechnung

Betreff:

Rechnung {{document.number}} von {{company.name}}

Text sinngemäß:

Guten Tag,

anbei erhalten Sie unsere Rechnung {{document.number}} über {{document.total}}.

Der Rechnungsbetrag ist bis zum {{document.dueDate}} fällig.

Vielen Dank.

## Zahlungserinnerung

Freundlicher, nicht aggressiver Text.

Hinweis:

* Rechnungsnummer
* Rechnungsdatum
* Betrag
* Fälligkeitsdatum
* offener Betrag

## Mahnung

Je Mahnstufe separate Standardvorlage.

Alle Texte müssen vom Benutzer bearbeitet werden können.

---

# 20. E-MAIL-VERSANDFENSTER

Vor dem Versand Modal öffnen.

Felder:

* Von
* An
* CC
* BCC
* Betreff
* Nachricht
* Signatur
* Anhänge

Option:

[ ] Kopie an mich senden

Automatisch anhängen:

* PDF
* bei E-Rechnung XML bzw. ZUGFeRD entsprechend sinnvoll

Zusätzliche Dateien anhängbar.

Vor Versand Vorschau.

---

# 21. E-MAIL-VERSANDKONFIGURATION

Self-hosted-freundliche Lösung.

Unterstützen:

### SMTP

* Host
* Port
* TLS
* Benutzer
* Passwort
* Absendername
* Absenderadresse

Optional Provider-Abstraction:

* SMTP
* Resend
* Amazon SES

Kein Vendor Lock-in.

Secrets nicht unverschlüsselt im UI ausgeben.

---

# 22. E-MAIL-HISTORIE

Für jedes Dokument Versandhistorie anzeigen.

Speichern:

* Empfänger
* CC/BCC
* Betreff
* verwendete Vorlage
* Versandzeitpunkt
* Provider-ID
* Status

Status:

* queued
* sent
* delivered
* bounced
* failed

Fehler anzeigen.

Aktionen:

* erneut senden
* E-Mail-Inhalt ansehen

Änderungs-/Auditlog entsprechend erweitern.

---

# PRIORITÄT P0 – MAHNWESEN

# 23. FLEXIBLE MAHNSTUFEN

Aktuelle feste Enum-Struktur:

REMINDER
DUNNING_1
DUNNING_2

durch ein flexibles Modell ersetzen.

Beispielsweise:

DunningStage

* id
* organizationId
* order
* name
* daysAfterDue
* newDueDays
* fee
* calculateInterest
* includeB2BFlatFee
* emailTemplateId
* documentTemplateId
* enabled

Standard:

0 Zahlungserinnerung
1 1. Mahnung
2 2. Mahnung
3 Letzte Mahnung

Aber:

Benutzer muss beliebig viele Stufen konfigurieren können.

KEIN festes Maximum.

---

# 24. MAHNFRISTEN

Pro Mahnstufe:

* Tage nach Fälligkeit
* neues Zahlungsziel
* Mahngebühr
* Verzugszinsen ja/nein
* 40-Euro-B2B-Pauschale ja/nein
* automatischer Versand ja/nein

Beispiel:

Zahlungserinnerung:
3 Tage nach Fälligkeit

1. Mahnung:
   10 Tage danach

2. Mahnung:
   10 Tage danach

Letzte Mahnung:
7 Tage danach

---

# 25. MAHNÜBERSICHT

Neue Seite:

/mahnwesen

Widgets:

Überfällige Rechnungen
Gesamt offen
1–7 Tage überfällig
8–30 Tage
31–60 Tage

> 60 Tage

Tabelle:

* Kunde
* Rechnung
* Rechnungsbetrag
* bereits bezahlt
* offen
* Fälligkeitsdatum
* Tage überfällig
* aktuelle Mahnstufe
* nächste Mahnung ab
* letzte Kontaktaufnahme

Aktionen:

* Zahlung erfassen
* Zahlungserinnerung senden
* nächste Mahnung erstellen
* Mahnung senden
* Mahnprozess pausieren
* Mahnprozess beenden

---

# 26. MAHN-AUTOMATISIERUNG

Built-in Scheduler implementieren.

Nicht mehr zwingend externen Cron voraussetzen.

Aber weiterhin Cron/API-Aufruf für Self-Hosting ermöglichen.

Scheduler prüft regelmäßig:

* Rechnung nicht bezahlt?
* Teilzahlung vorhanden?
* Rechnung storniert?
* Gutschrift vorhanden?
* Mahnprozess pausiert?
* nächste Mahnstufe erreicht?

Nur dann Mahnung erzeugen.

WICHTIG:

Automatischer Versand muss explizit aktivierbar sein.

Default:

automatische Erstellung erlaubt
automatischer E-Mail-Versand AUS

---

# 27. MAHNLOGIK BEI TEILZAHLUNGEN

Verzugszins und Forderung nur auf tatsächlich offenen Betrag berechnen.

Beispiel:

Rechnung 1.000 €
bezahlt 400 €
offen 600 €

Mahnungen → 600 € Forderungsbasis.

Tests erstellen.

---

# PRIORITÄT P1 – KUNDENKOMFORT

# 28. KUNDENSPEZIFISCHE DEFAULTS

Customer erweitern um:

* Standard-Zahlungsziel
* Standard-Zahlungsmethode
* Standard-Währung
* Standard-Rabatt
* bevorzugte Rechnungsadresse
* Lieferadresse
* Ansprechpartner
* E-Mail für Rechnungen
* CC Rechnungen
* E-Mail für Angebote
* E-Rechnung bevorzugt
* Leitweg-ID
* Bestellreferenz
* Lieferbedingungen
* Zahlungsbedingungen
* Sprache
* interne Notiz

Beim Erstellen eines Dokuments automatisch übernehmen.

---

# 29. MEHRERE KUNDENADRESSEN

Ein Kunde kann mehrere Adressen besitzen.

Typen:

* Hauptadresse
* Rechnungsadresse
* Lieferadresse
* sonstige

Beim Dokument auswählbar.

Die verwendete Adresse muss als Snapshot im Dokument gespeichert werden.

Spätere Kundenänderungen dürfen alte Dokumente nicht verändern.

---

# 30. ANSPRECHPARTNER

Unternehmen können mehrere Ansprechpartner besitzen.

Daten:

* Vorname
* Nachname
* Funktion
* Telefon
* Mobil
* E-Mail

Pro Dokument Ansprechpartner auswählbar.

Platzhalter:

{{contact.firstName}}
{{contact.lastName}}
{{contact.email}}

---

# 31. CUSTOM FIELDS

Benutzerdefinierte Kundenfelder.

Beispiele:

* Kundentyp
* Vertragsnummer
* Kostenstelle
* Standort
* Projekt-ID

Datentypen:

* Text
* Zahl
* Datum
* Boolean
* Auswahl

In Textvorlagen über Platzhalter verwendbar.

---

# 32. LETZTES DOKUMENT ÜBERNEHMEN

Komfortfunktion:

Beim Erstellen eines neuen Angebots/Rechnung/Auftragsbestätigung:

"Letzte Rechnung dieses Kunden übernehmen?"

Optionen:

* Positionen übernehmen
* Texte übernehmen
* Zahlungsbedingungen übernehmen
* Preise übernehmen

Alternativ Aktion:

"Dokument duplizieren"

---

# PRIORITÄT P1 – EINSTELLUNGEN

# 33. AUFTRÄGE & RECHNUNGEN EINSTELLUNGEN

Neue Settings-Seite.

## Allgemein

* Dokumenttyp + Nummer automatisch als Betreff
* beim Versand automatisch festschreiben
* Standardsprache
* Standardwährung

## Angebote

* Standard-Gültigkeit
* Lieferbedingungen
* Zahlungsbedingungen
* Standard-Kopftext
* Standard-Fußtext
* letzte Daten des Kunden anbieten
* Kunden-Annahme-Link standardmäßig aktiv
* bei Annahme automatisch Auftragsbestätigung erzeugen
* optional bei Annahme Rechnung erzeugen

## Auftragsbestätigung

* Lieferbedingungen
* Zahlungsbedingungen
* Standardtexte

## Lieferschein

* Preise anzeigen
* Artikelnummer anzeigen
* Lieferadresse anzeigen

## Rechnungen

* Standard-Zahlungsziel
* Zahlungszieltext anzeigen
* Lieferdatum automatisch setzen
* Rechnungsdatum bei alten Entwürfen aktualisieren
* letzte Rechnung des Kunden anbieten
* E-Rechnung standardmäßig aktivieren
* Standard-Zahlungsmethode

## Wiederkehrende Rechnungen

* Berechnungszeitraum automatisch einfügen
* automatisch festschreiben
* automatisch versenden

## Mahnwesen

* Mahnstufen
* Mahnfristen
* automatische Erstellung
* automatischer Versand

---

# 34. NUMMERNKREISE UI

NumberRange ist grundsätzlich vorhanden.

Fehlende vollständige UI implementieren.

Eigene Nummernkreise für:

* Kunde
* Produkt
* Angebot
* Auftragsbestätigung
* Lieferschein
* Rechnung
* Gutschrift
* Mahnung

Muster:

RE-{YYYY}-{SEQ:5}

ANG-{YY}-{SEQ:4}

LS-{YYYY}-{SEQ:5}

Variablen:

{YYYY}
{YY}
{MM}
{DD}
{SEQ}
{SEQ:4}
{SEQ:5}

UI:

* Muster
* nächste Nummer
* Reset jährlich ja/nein
* Vorschau

Concurrency-safe Nummernvergabe beibehalten.

Keine Nummern bei Entwürfen verbrauchen, sofern rechtlich/technisch für den jeweiligen Dokumenttyp sinnvoll.

---

# PRIORITÄT P1 – DOKUMENTDESIGN

# 35. BRIEFPAPIER / BRANDING

Settings:

* Logo
* Logo-Größe
* Firmenfarbe
* Absenderzeile
* Footer
* Seitenränder
* Schriftgröße
* Briefpapier-Hintergrund optional

PDF Preview.

---

# 36. PDF-DRUCKOPTIONEN

Globale Einstellungen und optional pro Dokument überschreibbar:

* Footer anzeigen
* Seitenzahlen
* Falzmarken
* Lochmarken
* Artikelnummer anzeigen
* Positionsbeschreibung anzeigen
* Umsatzsteuersatz pro Position anzeigen
* Positionssummen anzeigen
* Absenderzeile
* GiroCode

---

# 37. EPC-/GIROCODE

Optional QR-Code auf Rechnungen.

Daten:

* IBAN
* BIC soweit notwendig
* Zahlungsempfänger
* Betrag
* Rechnungsnummer als Verwendungszweck

QR-Code nach EPC-Standard.

Nicht mit normalem URL-QR-Code verwechseln.

---

# 38. DATEIANHÄNGE

Zu Dokumenten zusätzliche Dateien hinterlegen.

Beispiele:

* Leistungsnachweis
* Vertrag
* Produktinformation
* Garantiedokument
* Tätigkeitsbericht

Beim E-Mail-Versand auswählbar.

Speicherung sicher gestalten.

Dateityp-/Größenlimits.

Keine ausführbaren Dateien.

---

# PRIORITÄT P1 – RECHNUNGSÜBERSICHT

# 39. STATUSSYSTEM

Rechnungsstatus:

* Entwurf
* festgeschrieben
* offen
* teilbezahlt
* bezahlt
* fällig
* überfällig
* storniert

"fällig/überfällig" möglichst dynamisch aus dueDate + payment status berechnen und nicht unnötig redundant speichern.

---

# 40. RECHNUNGSFILTER

Filter:

* alle
* Entwürfe
* offen
* fällig
* überfällig
* teilbezahlt
* bezahlt
* storniert

Zusätzlich:

* Kunde
* Datum von/bis
* Betrag von/bis
* Rechnungsnummer
* Zahlungsart
* E-Rechnung
* Währung

Volltextsuche.

---

# 41. SCHNELLAKTIONEN

In Tabellen per Drei-Punkte-Menü:

* öffnen
* bearbeiten
* duplizieren
* PDF herunterladen
* XRechnung herunterladen
* per E-Mail senden
* erneut senden
* Zahlung erfassen
* Zahlungserinnerung
* nächste Mahnung
* Lieferschein erstellen
* stornieren

Nur zulässige Aktionen anhand Status anzeigen.

---

# 42. ZAHLUNG ERFASSEN

Zahlungsdialog:

* Betrag
* Datum
* Konto/Zahlungsart
* Referenz
* Notiz
* Skonto

Button:

"Restbetrag übernehmen"

Teilzahlung erlauben.

Bei vollständiger Zahlung:

Status automatisch PAID.

Bei Teilzahlung:

PARTIALLY_PAID.

Zahlungshistorie im Dokument anzeigen.

---

# PRIORITÄT P1 – WIEDERKEHRENDE RECHNUNGEN

# 43. RECURRING INVOICES ERWEITERN

Bestehende Funktion nutzen.

Intervalle:

* wöchentlich
* alle 2 Wochen
* monatlich
* alle 2 Monate
* quartalsweise
* halbjährlich
* jährlich
* benutzerdefiniert

Felder:

* Startdatum
* Enddatum optional
* nächster Lauf
* Anzahl Läufe optional
* automatisch festschreiben
* automatisch versenden
* E-Mail-Vorlage
* Berechnungszeitraum anzeigen

Status:

* aktiv
* pausiert
* beendet

Aktionen:

* jetzt Rechnung erzeugen
* pausieren
* fortsetzen
* beenden

Historie erzeugter Rechnungen anzeigen.

---

# PRIORITÄT P2 – KOMFORT UND PROFESSIONALISIERUNG

# 44. DOKUMENT-TIMELINE

Jedes Dokument bekommt eine Timeline.

Beispiel:

02.09.2026 14:21
Rechnung erstellt

02.09.2026 14:25
Rechnung festgeschrieben

02.09.2026 14:26
E-Mail an [kunde@example.de](mailto:kunde@example.de) versendet

02.09.2026 14:27
E-Mail zugestellt

16.09.2026
Zahlungsziel erreicht

20.09.2026
Zahlungserinnerung versendet

22.09.2026
Zahlung 500 € erfasst

AuditLog und ActivityLog sauber trennen:

AuditLog = revisionsrelevante Änderungen
ActivityLog = Benutzer-/Workflow-Aktivitäten

---

# 45. DASHBOARD OFFENE POSTEN

Dashboard Widgets:

Offene Forderungen
Überfällige Forderungen
Heute fällig
Diese Woche fällig
Teilbezahlt
Mahnungen erforderlich

Aging:

0–7 Tage
8–30 Tage
31–60 Tage
61–90 Tage

> 90 Tage

---

# 46. KUNDENDETAILSEITE

Kundenseite mit Tabs:

Übersicht
Angebote
Aufträge
Lieferscheine
Rechnungen
Zahlungen
Mahnungen
Dokumente

KPIs:

Gesamtumsatz
offene Forderungen
überfällige Forderungen
letzte Rechnung
letztes Angebot

---

# 47. DUPLIZIEREN

Jedes nicht revisionskritische Dokument bzw. ein finalisiertes Dokument als Vorlage duplizieren können.

Beim Duplizieren:

NEUE ID
NEUE Dokumentnummer erst bei entsprechender Finalisierung
neues Datum
keine Payment-Historie
keine Versandhistorie
keine Audit-Historie übernehmen

Nur Inhalte als Vorlage kopieren.

---

# 48. INTERNE NOTIZEN

Dokumente benötigen interne Notizen.

Diese dürfen NICHT:

* im PDF
* in XRechnung
* in ZUGFeRD
* in Kunden-E-Mails

erscheinen.

Deutlich im UI kennzeichnen:

"Nur intern sichtbar"

---

# 49. BENACHRICHTIGUNGEN

In-App Notifications:

* Rechnung heute fällig
* Rechnung überfällig
* Mahnstufe erreicht
* Angebot läuft bald ab
* wiederkehrende Rechnung fehlgeschlagen
* E-Mail bounced
* E-Rechnung konnte nicht validiert werden

Benutzer muss Benachrichtigungen konfigurieren können.

---

# 50. ARCHITEKTURANFORDERUNGEN

Keine riesigen monolithischen Komponenten.

Domainlogik framework-unabhängig halten.

Beispiele:

domain/
documents/
invoice/
quote/
delivery-note/
payment/
dunning/
email/
templates/
numbering/

Zod an allen API-Boundaries.

Money weiterhin ausschließlich integer cents bzw. bestehendes Geldmodell verwenden.

Keine Float-Berechnungen für Geld.

Transaktionen nutzen, wenn mehrere abhängige DB-Änderungen durchgeführt werden.

Snapshots für Dokumentdaten nutzen.

Historische Dokumente dürfen sich NICHT verändern, wenn später:

* Kunde geändert wird
* Produkt geändert wird
* Unternehmensdaten geändert werden
* Zahlungsbedingungen geändert werden

---

# 51. GOBD

Bestehende GoBD-Logik ist nicht verhandelbar.

Finalisierte Rechnungen:

NIEMALS direkt editieren.

Korrekturen ausschließlich:

* Storno
* Gutschrift
* Korrekturrechnung

Audit-Chain erhalten.

Neue relevante Aktionen in das Audit-System integrieren.

---

# 52. E-RECHNUNG

Bestehende XRechnung/ZUGFeRD-Funktionalität erhalten.

Neue Rechnungsfeatures müssen ebenfalls korrekt gemappt werden:

* Rabatt
* Skonto
* Zahlungsbedingungen
* Kundenreferenz
* Leitweg-ID
* Lieferzeitraum
* Zahlungsart
* Abschlags-/Teil-/Schlussrechnung soweit Standard dies unterstützt

Offizielle Validatoren weiterhin als CI-Gate verwenden.

Keine E-Rechnung erzeugen, die nur visuell korrekt aussieht, aber semantisch falsche XML-Daten enthält.

---

# 53. MIGRATIONEN

Für jede Schemaänderung:

* Prisma Migration erstellen
* SQLite berücksichtigen
* PostgreSQL berücksichtigen
* bestehende Daten migrieren
* keine destruktive Migration ohne Fallback

Bestehende Installationen müssen aktualisierbar bleiben.

---

# 54. TESTS

Für jede neue Domainfunktion Unit Tests.

Insbesondere testen:

### Rechnungen

* Netto
* Brutto
* 19 %
* 7 %
* mehrere Steuersätze
* Positionsrabatt
* Gesamtrabatt
* Aufschlag
* Rundung

### Teilrechnung

* Prozent
* Festbetrag
* mehrere Teilrechnungen

### Abschlags-/Schlussrechnung

* mehrere Abschläge
* Teilzahlungen
* unterschiedliche Steuersätze

### Skonto

* fristgerecht
* außerhalb Frist
* Teilzahlung

### Mahnwesen

* B2C
* B2B
* Verzugszins
* 40-Euro-Pauschale
* Teilzahlung
* beliebige Mahnstufen
* pausierter Mahnprozess
* bezahlte Rechnung darf nicht gemahnt werden
* stornierte Rechnung darf nicht gemahnt werden

### Dokumentketten

Angebot → Auftrag → Lieferschein → Rechnung

Beziehungen dürfen nicht verloren gehen.

---

# 55. MCP-SERVER ERWEITERN

Alle wichtigen neuen Funktionen auch über MCP verfügbar machen.

Beispiele:

"Erstelle für Müller GmbH ein Angebot über 10 Stunden Beratung zu 95 Euro."

"Erzeuge aus Angebot ANG-2026-00123 eine Auftragsbestätigung."

"Erstelle aus dem Auftrag einen Lieferschein."

"Erstelle eine Abschlagsrechnung über 30 Prozent."

"Welche Rechnungen sind überfällig?"

"Sende für RE-2026-00342 eine Zahlungserinnerung."

"Buche auf RE-2026-00342 eine Zahlung von 500 Euro."

"Erstelle die nächste Mahnstufe."

MCP-Tools benötigen die gleichen Validierungen und Berechtigungen wie UI/API.

Keine Bypass-Pfade.

---

# 56. UI/UX

Ziel:

schnelle, übersichtliche Rechnungssoftware für kleine Unternehmen.

Keine unnötig komplizierten ERP-Masken.

Wichtige Prinzipien:

* progressive disclosure
* Standardfelder sofort sichtbar
* selten benötigte Optionen unter "Weitere Optionen"
* klare Status-Badges
* Dokumentvorschau
* gute Tabellenfilter
* schnelle Aktionen
* verständliche deutsche Begriffe
* responsive Layout

Desktop hat Priorität, Mobile muss aber sinnvoll funktionieren.

---

# 57. NAVIGATION

Vorgeschlagene Navigation:

Dashboard

Verkauf

* Angebote
* Auftragsbestätigungen
* Lieferscheine
* Rechnungen
* Wiederkehrende Rechnungen
* Gutschriften
* Mahnwesen

Stammdaten

* Kunden
* Produkte

Einstellungen

* Unternehmen
* Aufträge & Rechnungen
* Textvorlagen
* E-Mail
* Zahlungsmethoden
* Nummernkreise
* Briefpapier
* Mahnwesen

---

# 58. UMSETZUNGSREIHENFOLGE

Bitte NICHT alles gleichzeitig unsauber implementieren.

Arbeite in folgenden Phasen:

## Phase 1

Repository Audit

Datenmodell für:

* DocumentRelation
* DeliveryNote
* TextTemplate
* EmailTemplate
* EmailLog
* CustomerAddress
* ContactPerson
* PaymentMethod
* DunningStage

## Phase 2

Textvorlagen
Platzhalter
E-Mail-Versand
E-Mail-Historie

## Phase 3

Dokumentverkettung
Angebot
Auftragsbestätigung
Lieferschein

## Phase 4

Rechnungskomfort:
Rabatte
Aufschläge
Skonto
Zahlungsmethoden
Anhänge
Positionsgruppen

## Phase 5

Teilrechnung
Abschlagsrechnung
Schlussrechnung

## Phase 6

flexibles Mahnwesen
Scheduler
Mahnübersicht

## Phase 7

Settings
Nummernkreise
PDF-Layout
GiroCode

## Phase 8

Dashboard
Timeline
Filter
UX-Verbesserungen

## Phase 9

MCP-Erweiterungen

Nach jeder Phase:

* TypeScript prüfen
* ESLint
* Tests
* Build
* Migrationen
* README/Docs aktualisieren

---

# 59. DEFINITION OF DONE

Eine Funktion gilt erst als fertig wenn:

1. Backend implementiert
2. UI implementiert
3. Validierung vorhanden
4. Berechtigungen berücksichtigt
5. Audit/Logging berücksichtigt
6. Tests vorhanden
7. SQLite getestet
8. PostgreSQL berücksichtigt
9. PDF-Auswirkungen geprüft
10. E-Rechnungs-Auswirkungen geprüft
11. MCP-Auswirkungen geprüft
12. Dokumentation aktualisiert

Keine TODO-Attrappen.

Keine Buttons ohne Backend.

Keine Mock-Daten in produktiven Pfaden.

Keine Funktionen nur oberflächlich im UI vortäuschen.

---

# 60. WICHTIGE ABGRENZUNG

Der Fokus dieses Auftrags liegt auf:

AUFTRAGSVERWALTUNG
+
RECHNUNGSWESEN
+
FORDERUNGSMANAGEMENT / MAHNWESEN

Noch NICHT primärer Bestandteil:

* komplette Finanzbuchhaltung
* Anlagenbuchhaltung
* Lohn
* Bilanz
* EÜR
* Steuererklärungen
* vollständiges Warenwirtschaftssystem
* komplexe Lagerverwaltung

Das Projekt soll zunächst die bestmögliche Open-Source-Lösung für den Prozess

Angebot
→ Auftrag
→ Lieferung
→ Rechnung
→ Zahlung
→ Mahnung

werden.

---

# 61. ZUM SCHLUSS

Nach dem Repository-Audit:

1. Erstelle zuerst eine kurze Tabelle mit:

   * Feature
   * bereits vorhanden
   * teilweise vorhanden
   * fehlt
   * geplante Änderung

2. Passe den Implementierungsplan anhand des TATSÄCHLICHEN Repository-Stands an.

3. Beginne danach DIREKT mit der Implementierung.

4. Bestehende gute Lösungen nicht neu schreiben.

5. Bevorzuge Erweiterung und Refactoring gegenüber parallelen zweiten Implementierungen.

6. Wenn Dokumentation und tatsächlicher Code voneinander abweichen, gilt der CODE als aktueller Stand.

7. Aktualisiere nach erfolgreicher Umsetzung:

   * README.md
   * README.de.md
   * ARCHITEKTUR.md
   * LIMITATIONEN.md
   * MCP-Dokumentation
   * ggf. COMPLIANCE.md

8. Führe abschließend:

   * Tests
   * Typecheck
   * Lint
   * Production Build
   * E-Rechnungs-Validatoren
     aus und behebe alle durch deine Änderungen entstandenen Fehler.