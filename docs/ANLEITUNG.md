# Anleitung — OpenInvoice Germany

Diese Anleitung führt dich von der Installation bis zur ersten fertigen, rechtssicheren Rechnung.

> ⚠️ Keine Steuer-/Rechtsberatung. Rechtliche Grundlagen mit Quellen: [COMPLIANCE.md](../COMPLIANCE.md).

---

## 1. Installation (Solo, ohne Server)

Voraussetzung: [Node.js](https://nodejs.org) ≥ 22.22 (Node 20 ist am Ende der Laufzeit; die Testsuite benötigt jsdom 31).

```bash
git clone https://github.com/c-sakel/open-invoice-germany.git
cd open-invoice-germany
npm install
cp .env.example .env        # Default: SQLite-Datei prisma/dev.db
npm run db:migrate          # legt die Datenbank an
npm run dev                 # startet http://localhost:3000
```

Optional Demo-Daten: `npm run db:seed` (1 Beispiel-Unternehmen, 1 Kunde, Produkte, eine festgeschriebene Rechnung; Demo-Login `admin@example.com` / `demo1234`).

Deine Daten liegen in `prisma/dev.db` — eine einzige Datei, die nur dir gehört. **Sichere sie regelmäßig** (kopieren genügt).

### Anmeldung & Konto

Beim allerersten Start führt dich `/setup` zur Einrichtung von E-Mail und Passwort für das (einzige) Admin-Konto — danach läuft jede weitere Anmeldung über `/login`. Nach **5 falschen Passworteingaben in Folge** wird das Konto **15 Minuten** gesperrt (die Anmeldeseite zeigt dieselbe allgemeine Fehlermeldung wie bei falschen Zugangsdaten, ohne Wartezeit); auch das richtige Passwort wird währenddessen abgelehnt. Unter **„Einstellungen → Konto"** änderst du dein Passwort (aktuelles Passwort + neues Passwort, mindestens 10 Zeichen) — das beendet **sofort alle anderen angemeldeten Sitzungen** (andere Browser/Geräte müssen sich neu anmelden), nur der Browser, in dem du gerade änderst, bleibt angemeldet. Zur Zwei-Faktor-Anmeldung und zum Passwort-Reset per E-Mail siehe den nächsten Abschnitt. Ohne eingerichteten E-Mail-Versand (SMTP und `APP_BASE_URL`) hilft bei einem verlorenen Passwort weiterhin nur ein direkter Zugriff auf die Datenbank; bei verlorenem zweiten Faktor das Notfallskript (siehe [SECURITY.md](../SECURITY.md) und BETRIEB-VORLAGE).

### Zwei-Faktor-Anmeldung (2FA) und Passwort vergessen

- **Einrichten** unter „Einstellungen → Konto“: Passwort eingeben, den QR-Code mit der Authenticator-App scannen (oder das angezeigte Geheimnis eintippen) und den 6-stelligen Code eingeben. Danach werden **zehn Wiederherstellungscodes** genau einmal angezeigt — sicher aufbewahren (Passwortmanager oder Ausdruck); sie sind nicht erneut abrufbar.
- **Anmeldung** mit 2FA: erst Passwort, dann auf der Folgeseite den Code aus der App **oder** einen Wiederherstellungscode (jeder gilt nur einmal). Die Folgeseite ist 5 Minuten gültig. Falsche Codes zählen wie falsche Passwörter zur Kontosperre (5 Fehlversuche, 15 Minuten).
- **Neue Wiederherstellungscodes** und **Abschalten** verlangen Passwort und einen aktuellen Code; beim Einrichten, Abschalten und Erneuern enden alle anderen Sitzungen.
- **Passwort vergessen?** Auf der Anmeldeseite „Passwort vergessen“ wählen. Die Anzeige ist immer dieselbe, ob die Adresse bekannt ist oder nicht. Bei bekannter Adresse kommt ein Link (30 Minuten gültig, einmal einlösbar); mit aktiver 2FA wird zusätzlich ein Code verlangt. Nach dem Zurücksetzen enden alle Sitzungen. Das setzt voraus, dass E-Mail-Versand (SMTP) eingerichtet und `APP_BASE_URL` gesetzt ist; sonst zeigt die Seite „nicht eingerichtet“.
- **Gerät und Codes verloren?** Nur der Server-Betreiber kann helfen: `scripts/disable-2fa.sh` (siehe BETRIEB-VORLAGE.md, „Notfallzugang“).

---

## 2. Erste Schritte in der App

Die linke Seitenleiste gliedert sich in drei Gruppen — **Übersicht** (Dashboard, ohne eigene Überschrift/Klappfunktion — ein einfacher Link), **Verkauf** (Angebote, Auftragsbestätigungen, Proforma, Lieferscheine, Rechnungen, Gutschriften, Wiederkehrend, Mahnwesen) und **Verwaltung** (Kunden, Produkte, Benachrichtigungen, Einstellungen). Die Gruppen *Verkauf* und *Verwaltung* lassen sich per Klick auf die Überschrift auf-/zuklappen; der Zustand wird je Gruppe im Browser gemerkt (übersteht ein Neuladen). Navigierst du in eine zugeklappte Gruppe hinein, öffnet sie sich einmalig automatisch. Über den Pfeil unten links lässt sich die gesamte Seitenleiste zusätzlich auf reine Icons einklappen.

### Schritt 1 — Unternehmen einrichten (`Einstellungen`)
Beim ersten Start wirst du hierher geführt. Trage deine Firmendaten ein. Pflicht für rechtskonforme Rechnungen (§ 14 UStG):
- **Firmenname + vollständige Anschrift**
- **Steuernummer ODER USt-IdNr.** (mindestens eines)
- Bankverbindung (für den Zahlungshinweis)
- optional: **E-Rechnung-Adresse** (BT-34) mit Schema, z. B. `9930` für deine USt-IdNr.; ohne Eintrag wird deine Firmen-E-Mail als `EM` verwendet
- optional: **Gläubiger-ID (SEPA)** — nur nötig, wenn du Rechnungen per Lastschrift einziehst. Die App prüft Format und Prüfziffer (Beispiel `DE98ZZZ09999999999`; Leerzeichen und Kleinbuchstaben werden beim Speichern normalisiert, eine ungültige ID wird mit Fehlermeldung abgelehnt)

Wähle dein **Standard-Steuerschema** (Regelbesteuerung oder Kleinunternehmer § 19). Speichern → fertig.

### Schritt 2 — Kunden anlegen (`Kunden → Neuer Kunde`)
Name, Anschrift, Typ (B2B/B2C). Die USt-IdNr. ist nur bei innergemeinschaftlichen Lieferungen/Leistungen Pflicht. Für Behörden trägst du die **Leitweg-ID** ein (sie wird mit Prüfziffer kontrolliert und als BT-10 sowie als elektronische Adresse mit Schema `0204` in die XRechnung geschrieben). Für Empfänger im Peppol-Netz hinterlegst du die **Peppol-ID** samt **Schema** (z. B. `0088` für eine GLN); die **Handelsregisternummer** (BT-47) genügt bei Reverse Charge anstelle der USt-IdNr. Ohne Peppol-ID und Leitweg-ID wird die E-Mail-Adresse des Kunden als elektronische Adresse verwendet — fehlt auch sie, warnt dich die App beim Festschreiben, weil die XRechnung dann die Prüfung nicht besteht.

**USt-IdNr. prüfen (VIES):** Auf der Kundenseite prüft der Knopf „USt-IdNr. prüfen (VIES)" die Nummer bei der EU-Kommission und speichert das Ergebnis samt Konsultationsnummer im Prüfprotokoll des Kunden (Nachweis für ig. Lieferungen). **Datenschutz:** Dabei werden die USt-IdNr. des Kunden und deine eigene USt-IdNr. an die EU-Kommission übermittelt, sonst nichts. Die Prüfung ist standardmäßig eingeschaltet; unter `Einstellungen → Belege` kannst du sie komplett abschalten („USt-IdNr.-Prüfung über VIES freischalten") oder die automatische Prüfung beim Festschreiben ein- und ausschalten. Wenn du es eingeschaltet hast (Standard: aus), fragt die App bei einer ig. Lieferung/Leistung beim Festschreiben einmal ab und zeigt dir das Ergebnis als Hinweis — das Festschreiben wird dadurch nie blockiert. Eine qualifizierte Bestätigung des BZSt ist nicht angebunden; daraus ergibt sich keine Pflicht zu einer zusätzlichen Bestätigung.

**SEPA-Lastschriftmandat:** Im Kundenformular gibt es den Block „SEPA-Lastschriftmandat“ mit Mandatsreferenz, Datum der Unterschrift, IBAN des belasteten Kontos und Kontoinhaber. **Mandatsreferenz und IBAN gehören zusammen** (Pflichtpaar: gibst du eines der Felder an, fehlt das andere → Fehlermeldung); Referenz höchstens 35 Zeichen ohne Leerzeichen. Die Kundendetailseite zeigt das Mandat mit **maskierter IBAN** (z. B. `DE02 **** 2051`), die Kundenliste zeigt keine IBAN; die volle IBAN steht nur im Bearbeitungsformular. Pro Kunde gibt es ein Mandat. **Mandat entfernen:** Button „Mandat entfernen“ im Block leert alle vier Felder; danach den Kunden speichern. Bereits festgeschriebene Rechnungen behalten ihren Snapshot.

Viele Kunden auf einmal: `Kunden → Importieren` (siehe „Export und Import (CSV)“ unten).

### Schritt 3 — (optional) Produkte anlegen (`Produkte`)
Ein Katalog spart Tipparbeit — du kannst Positionen aber auch direkt in der Rechnung eintippen. Eine Produktliste lässt sich per `Produkte → Importieren` als CSV einlesen (siehe „Export und Import (CSV)“ unten).

### Schritt 4 — Rechnung erstellen (`Neue Rechnung`)
Der Editor ist derselbe für Rechnung, Angebot/AB/Proforma und Lieferschein, läuft einspaltig (ein Block unter dem anderen) und bietet folgende Punkte: Kunde per Suche wählen (oder direkt im Editor über „+ Neuer Kunde" anlegen, ohne die Seite zu verlassen), Steuerschema, **Rechnungsdatum** (leer = Datum der Anlage) und **Leistungsdatum** — ein Haken „entspricht dem Rechnungsdatum" koppelt das Leistungsdatum ans Rechnungsdatum, bis du ihn entfernst, dann bleibt dein zuletzt eingetragenes Leistungsdatum stehen. **„Fällig am"** ist ein gekoppeltes Paar aus Datum **und** Tageszahl: gibst du ein Datum ein, springt die Tageszahl (Abstand zum Rechnungsdatum) automatisch mit, gibst du stattdessen eine Tageszahl ein (z. B. „14"), berechnet sich das Datum daraus. Ein Feld **„Betreff"** erscheint als eigene fette Zeile über dem Kopftext im PDF **und** — sofern gefüllt — als Notiz in der E-Rechnung (XRechnung/ZUGFeRD).

Positionen per Produktsuche (Link „Produkt auswählen" direkt in der Zeile) oder frei erfassen. Über das Zeilenmenü (⋯) lässt sich der Zeilentyp jederzeit zwischen Position, Überschrift, Textblock und Zwischensumme wechseln, Zeilen umsortieren (siehe „Positionen sortieren“ unten); `Enter` in der letzten Zeile legt eine neue an. Ein Segmentumschalter „Preise: netto/brutto" oberhalb der Positionstabelle zeigt zusätzlich den Bruttopreis je Position an — gespeichert wird immer netto. Unter den Positionen blendet der Link „**+ Gesamtrabatt**" vier Felder für einen Beleg-Rabatt/-Aufschlag (Prozent **und** Festbetrag, je addiert, plus Freitextgrund) ein — anders als der Positionsrabatt gilt er für den gesamten Beleg. Die Summe wird live berechnet; über „**Vorschau**" lässt sich das PDF des aktuellen, noch ungespeicherten Entwurfs jederzeit ansehen (Platzhalter wie `{{contact.firstName}}` sind aufgelöst; mit dem Hinweis „ENTWURF"/Wasserzeichen „VORSCHAU", schreibt nichts in die Datenbank). „**Als Entwurf anlegen**" speichert die Rechnung als **Entwurf** — frei änder- und löschbar, noch **ohne Rechnungsnummer**.

Das Anhänge-Panel steht bereits im Neuanlage-Editor bereit: lädst du dort — noch bevor du explizit auf „Speichern" geklickt hast — eine Datei hoch, speichert die App den Beleg automatisch als **Entwurf** (derselbe Weg wie der Speichern-Knopf, nur ohne Wechsel auf die Detailseite) und hängt die Datei daran an. Fehlen dabei Pflichtfelder, bricht der Upload mit einer Fehlermeldung ab, ohne Beleg oder Anhang anzulegen. Verlässt du den Editor mit ungespeicherten Änderungen über die Befehlspalette (`Strg`/`Cmd`+`K`), fragt eine Bestätigung nach, bevor die App wirklich wechselt — genau wie beim Zurück-Link und beim Schließen des Browser-Tabs.

**Einzelpreise mit bis zu 5 Nachkommastellen:** In Rechnung, Angebot/AB/Proforma und Abo darf der Einzelpreis bis zu fünf Nachkommastellen haben, z. B. `0,002` EUR je API-Aufruf. Die Positionssumme wird kaufmännisch auf ganze Cent gerundet; die E-Rechnung führt den exakten Preis (BT-146). Mehrdeutige Eingaben wie `1.234` im Preisfeld werden abgelehnt (Tausenderpunkt oder Dezimalpunkt?): Schreibe `1234` oder `1.234,00` bzw. `1,234`. Mehr als fünf Stellen und Preise über 21.474,83 EUR mit mehr als zwei Stellen sind nicht möglich. Produkte, Lieferscheine und das Teilgutschrift-Formular rechnen weiter in ganzen Cent.

**Währung:** Im Feld „Währung“ (Rechnung und Angebot/AB/Proforma, nicht Lieferschein) wählst du EUR, USD, GBP, CHF, DKK, SEK, NOK, PLN, CZK oder HUF. Vorbelegt wird nach der Reihenfolge Kunde (Vorgabe im Reiter „Vorgaben“) > Einstellung > EUR; eine manuelle Wahl wird durch späteren Kundenwechsel nicht überschrieben. Summen und Zeilenbeträge zeigen dann das Währungskürzel statt „€“. Bei Fremdwährung zeigt der Editor den geltenden Kurs mit Quelle und Kursdatum und die USt in EUR; einen abweichenden Kurs trägst du im Feld „Kurs manuell“ ein. Kein GiroCode bei Fremdwährung (siehe [LIMITATIONEN.md](LIMITATIONEN.md)). Dasselbe Feld gibt es im Abo-Formular (Vorbelegung Kunde > Einstellung); API und MCP nehmen `currency` (ISO-Code, drei Großbuchstaben) an.

**Sprache:** Das Feld „Sprache“ (Deutsch/Englisch) wird aus der Kundensprache vorbelegt und am Beleg eingefroren; PDF, E-Rechnungs-Hinweise und Mail-Vorlagen folgen ihr. Beim Wechsel der Sprache weist ein Pflichthinweis auf nicht übersetzte Freitexte hin, die du selbst anpasst. Englische Pflichthinweise tragen den deutschen Rechtswortlaut.

**Wechselkurse (`Einstellungen → Kurse`):** Bei Fremdwährung wird beim Festschreiben der Kurs eingefroren; die PDF zeigt „Exchange rate“/„Umrechnungskurs“ und „VAT in EUR“/„USt in EUR“, die XRechnung `TaxCurrencyCode` EUR. Standard ist der **amtliche Monatsdurchschnitt** (§ 16 Abs. 6 UStG): die App berechnet ihn aus den EZB-Referenzkursen, sobald mindestens 15 Tageskurse des Monats vorliegen, und bleibt dann fest. Weicht der Wert des BMF ab, trägst du ihn unter „Monatskurs pflegen“ ein; er hat Vorrang. Liegt der Monatskurs noch nicht vor, gilt der Vormonat (der Monat steht auf dem Beleg); bei Vorausrechnung (Leistungsdatum im Folgemonat) gilt der jüngste vorhandene Monatskurs. Storno und Teilgutschrift eines Altbelegs ohne Kurs fragen den Kurs im Dialog ab. Den **EZB-Tageskurs** wählst du unter Einstellungen → Belege nur, wenn dir das Finanzamt das gestattet hat. Der tägliche Abruf läuft im Scheduler (abschaltbar mit `FX_AUTO_FETCH=0`), „Jetzt abrufen“ startet ihn manuell; ein fehlgeschlagener Abruf erzeugt eine Benachrichtigung. Kurse über 2000 je EUR (IDR, VND) werden nicht unterstützt.

**Positionen sortieren:** Jede Zeile hat links einen Griff (⠿). Mit der **Maus** ziehst du ihn an eine neue Stelle; eine blaue Linie zeigt, wo die Zeile landet, am Rand scrollt die Seite mit. Eine **Überschrift** zieht ihren ganzen Block (bis zur nächsten Überschrift) mit. Auf dem **Touch-Gerät** hältst du den Griff kurz gedrückt (rund 0,2 s) und ziehst dann. Mit der **Tastatur** fokussierst du den Griff, drückst Leertaste (aufnehmen), Pfeil hoch/runter (Ziel wählen), Leertaste (ablegen) oder Escape (abbrechen); ein Screenreader-Hinweis nennt die neue Position. Alternativ verschiebt das Zeilenmenü (⋯) mit „Nach oben“, „Nach unten“, „Ganz nach oben“, „Ganz nach unten“; `Alt+↑`/`Alt+↓` funktioniert weiterhin.

**Zahlungsmethode Karte oder Lastschrift:** Wählst du im Editor eine Zahlungsmethode mit UNTDID-Code `48`, `54` oder `55` (Karte), erscheinen erst danach die Felder **Kartennetz**, **Letzte 4 Ziffern** und **Karteninhaber**. Gib nie die volle Kartennummer ein: die App speichert nur die letzten 4 Ziffern; mehr als 10 Ziffern werden mit einer Fehlermeldung (ohne Wiedergabe der Eingabe) abgelehnt. Bei der Methode SEPA-Lastschrift (Code `59`) gibt es keine Felder am Beleg; Gläubiger-ID, Mandatsreferenz und IBAN werden **beim Festschreiben** aus Firma und Kunde übernommen und am Beleg eingefroren. Die E-Rechnung enthält dann die Zahlungsgruppe der Karte bzw. des Mandats statt „nicht festgelegt“. Fehlen Angaben, wird trotzdem festgeschrieben; auf der Rechnungsseite erscheint ein Hinweis (z. B. „SEPA-Lastschrift: Gläubiger-ID der Firma oder Mandat (Referenz, IBAN) des Kunden fehlen“), und die E-Rechnung nennt die Zahlungsart als „nicht festgelegt“ (Code 1). Das PDF druckt bei Lastschrift eine **Vorabankündigung** (Betrag, Fälligkeitsdatum, maskierte IBAN, Mandatsreferenz, Gläubiger-ID) und bei Karte „Zahlung per Karte (Netz) **** 1234“; in beiden Fällen entfällt der **GiroCode**. Die Frist der Vorabankündigung prüft die App nicht.

### Schritt 5 — Festschreiben
Auf der Rechnungs-Detailseite: „**Festschreiben**". Dabei passiert (GoBD-konform):
- Die Pflichtangaben werden geprüft (fehlt etwas, bekommst du eine klare Meldung).
- Hinweise (z. B. fehlende elektronische Adresse des Kunden, VIES-Ergebnis) erscheinen als Banner auf der Rechnungsseite; sie blockieren nicht.
- Eine **fortlaufende Rechnungsnummer** wird vergeben (z. B. `RE-2026-0001`).
- Die Rechnung wird **unveränderbar**. Änderungen sind ab jetzt gesperrt.

### Schritt 6 — Exportieren
Die Rechnungs-Detailseite zeigt das **PDF direkt eingebettet** in der Seitenmitte (PDF-Ansicht deines Browsers im A4-Format; ohne eingebauten Viewer ein Link „PDF öffnen" als Download-Fallback). Rechts daneben fasst die **Statuskarte** Status, Kunde, Rechnungs-/Leistungsdatum, Fälligkeit und Brutto kompakt zusammen. Mit den Pfeilen `‹`/`›` neben dem Zurück-Link (oder `Alt+←`/`Alt+→` auf der Tastatur — unter Windows/Linux überlagert das den Browser-Zurück/Vor-Shortcut, siehe [LIMITATIONEN.md](LIMITATIONEN.md)) blätterst du zum vorherigen/nächsten Beleg der zuletzt geöffneten Liste, ohne zurückzuspringen. Eine interne Notiz (falls vorhanden) steht direkt darunter, immer sichtbar; die **Positionen** darunter sind ein einklappbarer Abschnitt (Kopfzeile zeigt Anzahl + Nettosumme, auch ohne Aufklappen).

Der Knopf **PDF** in der Kopfzeile (auch bei Entwürfen aktiv) öffnet die klassische „sonstige Rechnung" für E-Mail/Druck in einem neuen Tab — dasselbe PDF steht zusätzlich direkt eingebettet auf der Seite, s. o. Die E-Rechnungs-Exporte liegen im „**Mehr**"-Menü oben rechts:
- **XRechnung (XML)** — die strukturierte E-Rechnung nach EN 16931 für B2B/Behörden.
- **ZUGFeRD (PDF)** — Hybrid: lesbares PDF mit eingebettetem E-Rechnungs-XML.

Dasselbe „Mehr"-Menü bündelt außerdem Duplizieren, Teilgutschrift, Stornieren und die Lieferschein-Konvertierung — nur die im aktuellen Status tatsächlich erlaubten Einträge erscheinen.

**Menüs:** Das „Mehr"-Menü schließt per Klick außerhalb oder mit **Escape** (der Fokus springt auf „Mehr" zurück); einklappbare Abschnitte schließen nur per Escape.

### Stornieren, Teilgutschrift und Verrechnung (festgeschriebene Rechnung)
- **Stornieren** (Menü „Mehr“ oder Zeilenmenü der Liste): Ein Dialog zeigt Nummer, Stornobetrag (nach Teilgutschriften nur der **Rest**), bereits Bezahltes, fällige Erstattung und die Mahnstufe. Optional trägst du einen **Grund** ein — er steht in den Notizen der Storno-Gutschrift und ist damit im PDF und in der E-Rechnung für den Kunden sichtbar. Mit dem Haken „Stornorechnung danach per E-Mail senden“ öffnet sich nach dem Storno der Versanddialog. Die Stornorechnung (PDF-Titel „Stornorechnung“) trägt keine Zahlungsbedingungen. Eine Abschlagsrechnung, die in einer nicht stornierten Schlussrechnung verrechnet ist, lässt sich erst nach deren Storno stornieren. War bereits bezahlt, nennt die Belegseite die **fällige Erstattung**; die Rückzahlung selbst buchst du außerhalb der Software.
- **Teilgutschrift** (Menü „Mehr“): zeigt den noch gutschreibbaren Rest und den offenen Rest. Die Gutschrift **verrechnet** sich mit dem offenen Betrag (Zahlungsart „Verrechnung Gutschrift“, kein Geldeingang): Die Rechnung wird „Teilweise bezahlt“ bzw. „Bezahlt“; ein darüber hinausgehender Betrag ist zu erstatten (Hinweis nach dem Anlegen). Die Summe aller Gutschriften darf den Rechnungsbetrag nicht übersteigen; auf stornierte Rechnungen ist keine Teilgutschrift möglich.
- **Mehrere Rechnungen auf einmal stornieren (nur mit JavaScript):** In der Rechnungsliste (`/rechnungen`) erscheint vor jeder Rechnung, für die ein Storno angeboten wird, ein Kästchen (Entwürfe und Stornorechnungen haben keines). „**Alle auf dieser Seite**“ wählt die ganze Listenseite, höchstens 50 Rechnungen je Lauf. Der Dialog nennt Nummer und Betrag jeder gewählten Rechnung und verlangt einen **Grund** (Pflicht, er steht in der Stornorechnung). Danach zeigt der Bericht je Rechnung, ob sie storniert wurde (mit Link auf die Stornorechnung) oder warum nicht, z. B. weil sie in einer Schlussrechnung verrechnet ist. Jede Rechnung bekommt ihre **eigene Stornorechnung**; versendet wird dabei nichts. Ohne JavaScript bleibt die Liste samt Filtern nutzbar, es gibt aber keine Auswahl.
- **Listen:** Gutschriften (Storno- und Teilgutschriften, ohne Entwürfe) haben in der Rechnungsliste einen eigenen Tab „Gutschriften“ und erscheinen zusätzlich unter „Alle“; sie zählen nicht zu „Offen“.
- **Angebote/AB/Lieferscheine:** Auch **abgelaufene** Angebote lassen sich ablehnen oder stornieren; Stornieren fragt vorher nach und nennt verknüpfte Rechnungen, die bestehen bleiben.

### Lieferschein-Entwurf
Ein Lieferschein entsteht zunächst als **Entwurf**: ohne Nummer, ohne eingefrorene Kunden- und Lieferdaten, und er reserviert keine Restmenge des Quellbelegs. Solange er Entwurf ist, lässt er sich im Editor („Bearbeiten“ auf der Lieferschein-Seite) vollständig ändern — Positionen, Lieferanschrift, Ansprechpartner, Texte, Notizen und Daten; geleerte Felder werden tatsächlich geleert. Hat der Entwurf ein Quelldokument (Angebot/AB oder Rechnung), bleibt der Kunde der Quelle bindend; ein Kundenwechsel ist dann nicht möglich. Die PDF-Vorschau des Entwurfs zeigt bereits die gewählte Lieferanschrift und den gewählten Ansprechpartner. Mit **„Lieferschein erstellen“** wird der Entwurf wirksam: Die Nummer wird vergeben, Kunde, Anschrift und Ansprechpartner werden eingefroren, die Restmengen der Quelle werden hart geprüft, das PDF-Layout wird festgelegt und das Webhook-Ereignis `delivery_note.created` ausgelöst. Ab dann ist der Lieferschein nicht mehr bearbeitbar (nur Statuswechsel). Die Konvertierung aus Angebot/AB/Rechnung erzeugt direkt einen nummerierten Lieferschein.

### Schritt 7 — Zahlung & Mahnwesen (Rechnungs-Detailseite, `/mahnwesen`)
Zahlung und Mahnwesen sind Teil der Statuskarte auf der Rechnungs-Detailseite (kein eigener Reiter):
- **Zahlung buchen** — der Button „Zahlung erfassen" oben springt zum gleichnamigen, einklappbaren Abschnitt innerhalb der Statuskarte (bei offenem Betrag automatisch aufgeklappt); Teil- oder Vollzahlung, der Status springt auf *teilbezahlt* bzw. *bezahlt*.
- **Nächste Mahnstufe** — erzeugt die nächste fällige Mahnung nach den unter „Einstellungen → Mahnwesen" konfigurierten **Mahnstufen** (frei editierbar: Name, Tage nach Fälligkeit, neue Zahlungsfrist, Mahnkosten, Zinsberechnung an/aus, 40-€-Pauschale an/aus — vier Standardstufen sind vorbelegt, entsprechen aber keiner gesetzlichen Vorgabe). Mahnkosten sind erst ab der 2. Stufe zulässig (§ 288 Abs. 5 BGB, siehe [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 12); **Verzugszins** (taggenau, 5 Pp B2C/9 Pp B2B über dem jeweils gültigen Basiszins — bei einem Halbjahreswechsel innerhalb der Verzugsperiode stückelt die Mahnung den Zins abschnittsweise und weist jeden Abschnitt einzeln aus) und **40-€-Pauschale** (nur B2B, einmalig je Rechnung) greifen, wenn die jeweilige Stufe das vorsieht. Die Zinsen laufen erst **ab Verzugseintritt**: nach einer versendeten Mahnung, die nach der Fälligkeit erstellt wurde (E-Mail: Zugang am Folgetag, Post: nach drei Tagen; die Zinsen beginnen am Tag danach), oder 30 Tage nach Fälligkeit und Zugang der Rechnung (Zinsen ab dem Tag nach Fristende; bei Verbrauchern nur mit Verzugshinweis in der Rechnung); Der Beginn steht in der Mahnansicht und im PDF, der Grund in der Mahnansicht, in der REST-API und im MCP. Fällt das Fristende der 30 Tage auf Samstag, Sonntag oder einen bundeseinheitlichen Feiertag, beginnen die Zinsen einen Werktag später (§ 193 BGB). 40-€-Pauschale und Mahnkosten werden nur gebucht, wenn der Verzug zum Zeitpunkt der Mahnung eingetreten ist. Ist noch kein Verzug eingetreten, beträgt der Zins 0 Cent. Jede Mahnung gibt es als PDF. Über **Mahnprozess pausieren/beenden** lässt sich eine Rechnung vorübergehend (mit Datum) oder dauerhaft von weiteren automatischen Mahnungen ausnehmen.
- **Zahlung korrigieren** — falsch erfasst? In der Zahlungsliste der Statuskarte „Zahlung korrigieren“ wählen, Grund (mindestens 3 Zeichen) und optional einen Teilbetrag angeben. Die Originalzahlung bleibt sichtbar (durchgestrichen), eine Gegenbuchung mit Grund kommt hinzu, der Status geht entsprechend zurück. Zahlungen lassen sich nicht löschen (GoBD).
- Die Seite **`/mahnwesen`** zeigt eine Übersicht aller überfälligen, offenen Rechnungen (Fälligkeits-„Aging" in Tagesgruppen, Summe offener Beträge, nächste fällige Stufe je Rechnung) über alle Kunden hinweg.
- **Automatisierung:** Unter „Einstellungen → Mahnwesen" steuerst du **Auto-Erstellung** (Default an) und **Auto-Versand** (Default **aus** — bewusst konservativ, erst nach Prüfung der Vorlagen/Mahnstufen aktivieren) global sowie je Stufe (`Auto-Versand` als Schalter an der einzelnen Mahnstufe). Ist beides aktiv, verschickt der eingebaute Scheduler (siehe Schritt 8) fällige Mahnungen ohne manuelles Zutun per E-Mail.
- **Basiszinssatz pflegen:** ebenfalls unter „Einstellungen → Mahnwesen" — eine Tabelle statt eines einzelnen Feldes, weil sich der gesetzliche Basiszinssatz zweimal jährlich ändert (§ 288 Abs. 1 Satz 2 BGB, Bekanntgabe der Deutschen Bundesbank zum 01.01./01.07.). Anlegen/Ändern/Löschen je Stichtag (Satz in Prozent, intern Basispunkte); der letzte verbleibende Eintrag lässt sich nicht löschen. Eine neue Mahnung übernimmt automatisch den zum Verzugszeitraum passenden Satz — bereits erstellte, festgeschriebene Mahnungen ändern sich dabei nicht (GoBD-Snapshot). Auch per REST (`/api/v1/BaseInterestRate`) und MCP (`list_base_interest_rates`/`set_base_interest_rate`/`delete_base_interest_rate`, siehe [MCP.md](MCP.md)) pflegbar.

### Schritt 8 — Eingebauter Scheduler, wiederkehrende Rechnungen / Abos (`Abos`, „Einstellungen → Automatisierung")
Die App bringt einen **eingebauten Scheduler** mit: im laufenden Prozess (`npm run dev`/`next start`, auch im Docker-Image) prüft ein Intervall-Loop automatisch alle paar Minuten, ob Mahnungen fällig sind oder Abo-Rechnungen erzeugt werden müssen (Steuerung über `SCHEDULER_ENABLED`/`SCHEDULER_INTERVAL_MINUTES`, siehe `.env.example`). Unter „Einstellungen → Automatisierung" siehst du die letzten Läufe (Zeitpunkt, Status, Zusammenfassung) und kannst per Knopf **„Jetzt prüfen"** sofort einen Lauf anstoßen.

Für regelmäßige Leistungen (Wartung, Retainer, Miete): Lege ein **Abo** an — Kunde, Positionen, Rhythmus (wöchentlich bis jährlich), Startdatum, optional Enddatum. Wahlweise werden die erzeugten Rechnungen **automatisch festgeschrieben**. **Jetzt Rechnung erzeugen** auf der Abo-Seite erstellt sofort die nächste Rechnung.

**Sammelrechnung:** Mehrere Abos desselben Kunden können in **einer** Rechnung abgerechnet werden. Dafür im Abo-Formular „Sammelrechnung" einschalten und eine **Blocküberschrift** eintragen (Pflicht, höchstens 200 Zeichen). Die Überschrift ist öffentlich und steht auf der Rechnung. Jedes Abo bildet einen Block aus Überschrift, Positionen und Zwischensumme; die Rechnung trägt den Gesamtzeitraum aller Blöcke.
- **Wann zusammengefasst wird:** Alle fälligen, aktiven Abos mit eingeschaltetem Schalter, die zum selben Kunden und zum selben Stichtag (Berliner Kalendertag) gehören und in Währung, Steuerschema, Sprache, Zahlungsziel sowie Auto-Festschreiben und Auto-Versand übereinstimmen. Die Mailvorlage trennt Gruppen nur, wenn Auto-Versand an ist. Abos, die abweichen, werden getrennt abgerechnet; die Abo-Seite nennt den Grund.
- **Grenzen:** höchstens 50 Abos je Sammelrechnung, weitere bilden die nächste Gruppe. Ein einzelner Block ergibt eine normale Rechnung wie ohne Schalter.
- **Verbrauchsabos:** Ist ein Verbrauchsabo Mitglied, wird die ganze Gruppe erst am Berliner Folgetag nach dem Stichtag abgerechnet. „Jetzt erzeugen" rechnet die Gruppe sofort ab, lässt aber noch nicht fällige Verbrauchspartner aus; ist das Verbrauchsabo selbst noch nicht fällig, wird abgelehnt.
- **Fehler:** Ein defektes Abo wird aus der Gruppe isoliert und gemeldet, die übrigen werden abgerechnet. Scheitert der Gruppenpfad selbst, rechnet der Scheduler-Lauf jedes Abo als Einzelrechnung ab und legt eine Benachrichtigung an; beim manuellen „Jetzt erzeugen" gibt es diesen Rückfall nicht.
- **Belegansicht:** Die Rechnung zeigt „Herkunft je Block", die Abo-Seiten listen die Rechnung. Die Herkunft je Position wird nicht festgeschrieben: Bearbeitest du die Positionen eines Entwurfs, geht sie verloren (die Verknüpfung zum Abo bleibt). Storno und Teilgutschrift gelten für die ganze Rechnung.

**Vorrangregel bei Abo-Läufen (§28–§30):** Jede erzeugte Rechnung läuft über denselben Erstellungspfad wie eine manuell angelegte Rechnung. Was das Abo selbst festlegt — Steuerschema, Währung, Notiz, Positionen und die im Abo hinterlegte **Zahlungsfrist** —, überstimmt in jedem Fall eine abweichende Kundenvorgabe. Alles, was das Abo nicht kennt, kommt dagegen aus den **Kundenvorgaben**: Zahlungsart, Ansprechpartner, Rechnungs-/Lieferadresse, **Kundenrabatt**, Bestellreferenz, Zahlungsbedingungstext sowie Kopf-/Fußtextvorlage. Die Abo-Detailseite zeigt einen eigenen Block „Aus den Kundenvorgaben übernommen" mit den aktuell wirksamen Werten. **Prüfabfrage beim Update von einer älteren Version:** Hat ein Kunde mit laufendem Abo einen hinterlegten `Kundenrabatt` (§28) größer 0 %? Falls ja, sinkt der Rechnungsbetrag ab dem nächsten Lauf dieses Abos entsprechend — das ist die beabsichtigte Fehlerbehebung, kein Defekt, sollte aber vor dem ersten Lauf nach dem Update bekannt sein. **Zweite Prüfabfrage:** Ist bei einem Bestandsabo der Leistungszeitraum-Text (`showPeriodText`) ausgeschaltet UND existiert eine als Standard markierte Kopftextvorlage (Einstellungen → Textvorlagen, Position „Kopf") für Rechnungen? Falls ja, bekommt die ab dem nächsten Lauf dieses Abos erzeugte Rechnung erstmals genau diesen Kopftext, statt wie bisher ganz ohne Kopftext zu bleiben — ebenfalls die beabsichtigte Angleichung an den manuellen Rechnungspfad , aber eine sichtbare PDF-Änderung für Bestandsabos. **Dritte Prüfabfrage:** Hat ein Kunde mit laufendem Abo eine als Standard markierte Lieferadresse (Einstellungen → Kunden, Adresstyp „Lieferung")? Falls ja, bekommt die ab dem nächsten Lauf dieses Abos erzeugte Rechnung erstmals einen Lieferanschrift-Block im PDF sowie die entsprechenden Felder (BG-13/BG-15) in XRechnung/ZUGFeRD — ebenso greifen ab diesem Lauf erstmals eine hinterlegte Zahlungsart, ein Ansprechpartner, die Bestellreferenz (BT-13) und ein Zahlungsbedingungstext, sofern beim Kunden gepflegt; auch das ist die beabsichtigte Angleichung an den manuellen Rechnungspfad, aber eine sichtbare PDF-/XML-Änderung für Bestandsabos.

**Cron-Alternative** — wer den eingebauten Loop nicht nutzen will (z. B. `SCHEDULER_ENABLED=false`, oder mehrere App-Instanzen ohne Loop), kann denselben Vorgang per Cron/CLI anstoßen — der DB-Mutex (`SchedulerLock`) sorgt dafür, dass sich Loop, Cron und manuelle Läufe nie überschneiden:

```bash
npm run recurring:run        # erzeugt alle fälligen Abo-Rechnungen
npm run dunning:run          # erzeugt (und ggf. versendet) alle fälligen Mahnungen
npm run scheduler:run        # beide Jobs in einem Lauf (Reihenfolge: recurring, dann dunning)
```

Beispiel-Crontab (täglich 06:00, alle drei Jobs):
```
0 6 * * *  cd /pfad/zur/app && /usr/bin/npm run scheduler:run >> scheduler.log 2>&1
```
Alternativ per HTTP (mit Header `Authorization: Bearer $CRON_SECRET`, sofern `CRON_SECRET` gesetzt ist): `GET/POST /api/cron/run-recurring` (nur Abos), `GET/POST /api/cron/run-dunning` (nur Mahnwesen), `GET/POST /api/cron/run-all` (beide Jobs seriell, wie `scheduler:run`). Ohne gesetztes `CRON_SECRET` sind alle drei Routen gesperrt (503) — siehe `.env.example`.

**Erst-Deploy auf einen Bestand mit bereits festgeschriebenen Rechnungen:** Neu angelegte Organisationen bekommen `autoCreate: true` (Scheduler mahnt automatisch), Bestandsorganisationen (mindestens eine festgeschriebene Rechnung zum Zeitpunkt, an dem die Mahnwesen-Einstellungen zum ersten Mal angelegt werden) automatisch `autoCreate: false` — der eingebaute Loop erzeugt dann keine Mahnungen über den Altbestand, ohne dass das jemand konfigurieren müsste. `/mahnwesen` zeigt einen Hinweis, solange `autoCreate` aus ist. Für ein erstes Docker-Deployment auf einen bestehenden Datenbestand zusätzlich empfohlen: `SCHEDULER_ENABLED=false` beim allerersten Start setzen, nach dem Rollout `/mahnwesen` sichten (überfällige Rechnungen, aktuelle Mahnstufen) und danach bewusst `SCHEDULER_ENABLED=true` (oder unset, das ist der Default) setzen und neu starten.

---

### E-Mail: HTML-Version (`Einstellungen → E-Mail`)
Unter „HTML-Version“ schaltest du mit **„HTML-Version mitsenden“** (Standard **aus**) einen zusätzlichen HTML-Teil für ausgehende Mails ein: Beleg-Mails, Angebots-Benachrichtigungen, Tages-Digest und die Testmail. Der Text bleibt unverändert enthalten, das Mailprogramm zeigt die HTML-Fassung nur zusätzlich an. Die **Vorschau** daneben zeigt Text- und HTML-Fassung mit einem Beispieltext. Die HTML-Fassung enthält **kein Logo, keine Bilder, keine externen Inhalte und kein Tracking**; Formatierungen aus den Vorlagen erscheinen als Text, Web- und Mailadressen als sichtbare Links in deiner Markenfarbe (sofern sie genug Kontrast hat). Die **Passwort-Reset-Mail** bleibt immer reiner Text. Nach dem Einschalten prüfst du die Darstellung am besten mit „Testmail senden“.

## 2a. Postversand

Rechnungen (auch Gutschriften und Stornorechnungen) und Mahnungen lassen sich über einen Briefdienst drucken und per Post zustellen lassen. Gesendet wird immer das **archivierte PDF** des Belegs, nie ein neu gerendertes. Der Beleg selbst ändert sich dabei nicht: Der Rechnungsstatus wechselt nicht auf „versendet“; im Verlauf erscheint nach einer Live-Übertragung der Eintrag „Per Post versendet“, das vollständige Ergebnis steht im **Versandprotokoll**. Eine stornierte Rechnung und eine Mahnung zu einer bezahlten oder stornierten Rechnung lassen sich nicht per Post senden. Angebote und Lieferscheine lassen sich (noch) nicht per Post senden.

### Einrichten (`Einstellungen → Postversand`)
1. Benutzername und API-Schlüssel des Briefdienstes eintragen und speichern. Der Schlüssel (mindestens 16 Zeichen) wird verschlüsselt abgelegt; danach zeigt die Seite nur „hinterlegt ••••xxxx“ (die letzten vier Zeichen, und nur bei Schlüsseln ab 12 Zeichen), nie den Klartext. „Entfernen“ löscht ihn. Das Feld bleibt beim Öffnen leer.
2. Druckoptionen wählen: schwarz/weiß oder Farbe, einseitig oder doppelseitig, Versandart (automatisch nach Land der Anschrift, national, international) und optional ein Standard-Einschreiben („Einschreiben Einwurf“ oder „Einschreiben“, nur bei Anschrift in Deutschland).
3. Optional ein **Monatsbudget** (Euro, nur Modus Live) setzen; leer = kein Limit.
4. „**Verbindung prüfen**“ fragt ausschließlich das Guthaben ab und versendet nichts. Der Knopf macht nur auf Klick einen Netzaufruf, nie der Scheduler.

### Schalter und Modi
Der Postversand ist **ab Werk ausgeschaltet**. Es gibt zwei getrennte Schalter und drei Modi:

| Postversand | Modus | Was passiert beim Senden |
|---|---|---|
| aus | egal | **Trockenlauf**: Das Protokoll entsteht, es wird nichts übertragen, auch kein Preis abgefragt („Preis wird erst bei eingeschalteter Verbindung abgefragt“). |
| an | Trockenlauf | Der Preis wird abgefragt (lesend), übertragen wird nichts. |
| an | Testmodus des Briefdienstes | Der Auftrag wird in die **Postbox** des Briefdienstes gelegt. Der Testmodus ist **keine Sandbox**: Dort lässt sich der Brief **manuell versenden**, dann wird er gedruckt, zugestellt und berechnet. Ist ein Testauftrag beim Briefdienst nicht mehr auffindbar (Postbox nach 7 Tagen geleert), setzt das Programm ihn auf „storniert“. |
| an | Live | Der Brief wird kostenpflichtig gedruckt und versendet. |

- **Bestätigungen:** Jeder Wechsel auf Testmodus oder Live verlangt in den Einstellungen eine ausdrückliche Bestätigung (Warnbox, Pflicht-Checkbox); die Domain lehnt den Wechsel ohne Bestätigung ab, auch über die Oberfläche hinaus. Ohne Bestätigung bleibt der bisherige Modus.
- **Zweiter Schalter „Mahnautomatik darf ohne Rückfrage per Post versenden“:** Nur wenn er an ist (zusätzlich zum Postversand), überträgt der Scheduler automatisch erzeugte Mahnungen selbst. Sonst erscheinen sie unter **Mahnwesen → „Post ausstehend“** und gehen erst nach deiner Bestätigung hinaus.
- Die Schalter, Zugangsdaten und das Budget lassen sich nur in der Oberfläche ändern, nicht per REST oder MCP.

### Einzelversand
Im Menü „Mehr“ der Rechnung bzw. bei einer Mahnung im Abschnitt Zahlung/Mahnwesen („Per Post senden“): Der Dialog zeigt Anschrift, Seitenzahl, Versandart, Modus und die **Kosten laut Preisabfrage** (sobald der Postversand eingeschaltet ist; der Briefdienst nennt nicht, ob der Preis netto oder brutto ist). Erst „Bestätigen“ löst den Versand aus. Zwischen Anzeige und Versand wird der Preis erneut geprüft; weicht er ab (oder hat sich das PDF geändert), wird nichts gesendet und der Dialog lädt das Angebot neu. Unvollständige Anschriften (Name, Straße, PLZ, Ort fehlen) und Belege über 50 MB werden vorab abgelehnt. Ein Beleg lässt sich nur einmal senden; ein erneuter Versand braucht eine ausdrückliche Wiederholung mit Kostenhinweis und ist nur nach abgeschlossenem Brief möglich, **nie** solange ein Auftrag des Belegs läuft oder unklar ist (dann erst „Manuell abschließen“).

### Testaufträge sperren den Echtversand
Weil ein Testauftrag in der Postbox manuell versendet werden kann, **sperrt ein aktiver Testauftrag den Live-Versand desselben Belegs** (auch bei „Wiederholen“). Erst den Testauftrag **stornieren**. Ist er nicht mehr stornierbar (siehe unten), bleibt die Sperre bestehen: Beim Wechsel von Test auf Live gleicht der Scheduler Testaufträge weiter ab (die Postbox wird nach 7 Tagen geleert, dann gilt der Auftrag als storniert); alternativ schließt du einen aktiven Testauftrag nach Ablauf der Stornofrist im Protokoll über „Als nicht versendet abschließen“ ab (mit Begründung). Ein **abgeschlossener** Testauftrag (Status „versendet“) sperrt den Live-Versand dauerhaft, weil der Brief tatsächlich gedruckt wurde.

### Storno, Abgleich, unklare Aufträge
- **Storno** ist nur binnen **15 Minuten** nach der Übertragung möglich und nur für Aufträge in der Warteschlange (Entwurf/wartet/angehalten), nicht für Trockenläufe und nicht, wenn der Brief schon fertig ist. Die Oberfläche fragt vor dem Storno nach.
- Der Scheduler-Job **postal** gleicht den Status jedes aktiven Auftrags (aller Modi, auch Testaufträge nach einem Moduswechsel) frühestens alle 15 Minuten mit dem Briefdienst ab (es gibt keinen Rückruf), verfolgt bei Einschreiben die Sendung bis zu 14 Tage und meldet Fehlschläge als Benachrichtigung „Postversand fehlgeschlagen“.
- **Unklarer Ausgang (UNKNOWN)** entsteht, wenn die Antwort des Briefdienstes ausblieb. Das Programm sendet dann **nie automatisch neu** (es gäbe sonst Doppelbriefe), sondern sucht den Auftrag über den eindeutigen Dateinamen in den Listen des Briefdienstes. Findet es ihn nach 60 Minuten nicht und konnte die Listen vollständig lesen, endet der Auftrag als „fehlgeschlagen“. Bleibt er unklar, schließt du ihn nach Prüfung im Konto des Briefdienstes **manuell ab**: „Manuell abschließen“ im Protokoll oder im Rechnungsverlauf, „versendet“ oder „nicht versendet“ mit Pflichtbegründung (mindestens 3 Zeichen). Bei „nicht versendet“ ist ein erneuter Versand wieder möglich.
- Hängende Aufträge, die nie übertragen wurden (Abbruch während der Vorbereitung), setzt der Scheduler nach 10 Minuten auf „fehlgeschlagen“.

### Protokoll, Kosten, Monatssummen
Das Versandprotokoll steht auf der Einstellungsseite (letzte 100 Aufträge) und je Beleg unter dem E-Mail-Verlauf. Es zeigt Datum, Beleg, Modus, Status, Seitenzahl, Preis (der berechnete, sonst der aus dem Angebot), Einschreiben bzw. Sendungsverfolgung, die Prüfsumme und die Ereignisse; der Auslöser (Nutzer, Automatik, API, MCP) steht im Auftrag. Der Trockenlauf-Eintrag trägt dieselbe SHA-256-Prüfsumme wie das Archiv-PDF. Die **Monatssummen** der letzten 12 Monate zeigen je Monat die Anzahl und Kosten der Live-Aufträge sowie die Anzahl der Test- und Trockenlauf-Aufträge getrennt.

### Versandart je Kunde und Kanal je Mahnstufe
- **Kunde → „Versandart für Mahnungen“:** E-Mail (Standard), Post oder E-Mail und Post.
- **Einstellungen → Mahnwesen → Mahnstufen → „Kanal“:** „Kundenvorgabe“ (Standard), E-Mail, Post oder E-Mail und Post. „**Ohne E-Mail-Adresse per Post**“ (Standard an) schickt Mahnungen für Kunden ohne E-Mail-Adresse per Post, **aber nur bei eingeschaltetem Postversand**; sonst bleibt das bisherige Verhalten (keine Mail, Meldung „Mahnung nicht versendet“).
- Die Mahnautomatik sendet zuerst die E-Mail, danach die Post. Fehlt jeder Weg (keine Adresse, kein Postfallback), meldet sie „Mahnung nicht versendet“, statt die Mahnung still zu überspringen. Probleme beim Postversand (z. B. unvollständige Anschrift) erscheinen als Fehler mit Meldung.

### „Post ausstehend“ und Sammelversand
`/mahnwesen#post` (nur bei eingeschaltetem Postversand sichtbar) listet automatisch erzeugte Mahnungen mit Postkanal, die auf Bestätigung warten (letzte 90 Tage, nur offene Rechnungen). „Vorschau“ zeigt je Mahnung Anschrift und Preis sowie die **Gesamtkosten**; erst die Bestätigung sendet, nacheinander mit Pause zwischen den Anfragen des Briefdienstes. Ein Sammelversand in der Rechnungsliste existiert nicht.

### Datenschutz
Beim Postversand werden Belegdaten (Anschrift, PDF) an den Briefdienst übertragen; dafür ist ein Auftragsverarbeitungsvertrag mit dem Anbieter nötig (COMPLIANCE.md § 21).

---

## 2b. Export und Import (CSV)

### Export
Auf den Listen Rechnungen, Dokumente (Angebote/Auftragsbestätigungen), Lieferscheine, Kunden und Produkte lädt der Link **CSV** die Liste mit dem **aktiven Filter** als Datei (`<liste>-<Datum>.csv`: Semikolon, deutsche Zahlen, UTF-8 mit BOM, öffnet in Excel und LibreOffice direkt). Höchstens 20.000 Zeilen; bei mehr Treffern Filter einschränken. **Formelschutz:** Textzellen, die mit `=`, `+`, `-` oder `@` beginnen, erhalten ein vorangestelltes `'`, damit die Tabellenkalkulation sie nicht als Formel ausführt.

### Import (`Kunden → Importieren`, `Produkte → Importieren`)
Es werden nur **neue** Datensätze angelegt; bestehende bleiben unberührt. Ablauf:
1. **Vorlage** herunterladen (Kopfzeile plus Beispielzeile) oder eine eigene Datei vorbereiten (UTF-8 oder Windows-1252, Trennzeichen `;` oder `,`, höchstens 2 MB und 2.000 Zeilen).
2. Datei wählen und **Vorschau prüfen**: Die Vorschau zeigt Zeilenzahl, Fehler je Zeile und Spalte (höchstens 200 angezeigt), ignorierte Spalten und die ersten Beispielzeilen.
3. Ist die Datei fehlerfrei, legt **Importieren** alle Zeilen an. Ein einziger Fehler verhindert den Import der ganzen Datei. Dieselbe Datei innerhalb von 24 Stunden erneut zu importieren fragt nach einer Bestätigung.

Spalten Kunden (Kopf, Pflicht, Format; Aliase wie `Strasse`, `Email` werden erkannt):

| Kopf | Pflicht | Format |
|---|---|---|
| Name | ja | Text |
| Straße | ja | Text |
| PLZ | ja | Text |
| Ort | ja | Text |
| Kundennummer | nein | leer = nächste Nummer aus dem Nummernkreis |
| Typ | nein | `Firma` (Standard) oder `Privat` |
| Ansprechpartner, Adresszusatz, Telefon, Registernummer | nein | Text |
| Land | nein | Ländercode, z. B. `DE` |
| E-Mail | nein | gültige Adresse |
| USt-IdNr., Leitweg-ID, Peppol-ID, Peppol-Schema | nein | wie im Kundenformular geprüft |
| Zahlungsziel (Tage) | nein | Ganzzahl 0–365 |

Spalten Produkte:

| Kopf | Pflicht | Format |
|---|---|---|
| Bezeichnung | ja | Text |
| Nettopreis | ja | Betrag, z. B. `95,00` oder `1.234,56` |
| Artikelnummer | nein | Text, je Organisation eindeutig |
| Beschreibung | nein | Text |
| Einheit | nein | Einheit wie in der App, z. B. `Std` |
| Steuersatz (%) | nein | Ganzzahl 0–100, muss freigegeben sein |
| Steuerkategorie | nein | `S` (Standard), bei den übrigen Kategorien 0 % |
| Differenzbesteuerung | nein | `ja` / `nein` |
| OSS-Kategorie | nein | wie im Produktformular |

Eine Kundennummer, die schon vergeben ist, oder ein Kunde mit gleicher E-Mail und gleichem Namen wird als Fehler gemeldet. Mehr Grenzen: [LIMITATIONEN.md](LIMITATIONEN.md).

## 2c. Eingangsrechnungen (`Eingang`)

Hier legst du Rechnungen deiner Lieferanten ab, liest sie und prüfst sie gegen EN 16931 und XRechnung. Die Anwendung bucht nichts und kontiert nichts; sie ersetzt weder den Posteingang noch die Prüfung durch deinen Steuerberater.

### Rechnung ablegen

- **Per Oberfläche:** Dateien auf die Fläche im Menü „Eingang“ ziehen oder per Auswahl hinzufügen (bis 20 Dateien je Vorgang, je Datei höchstens 15 MB). Ergebnis je Datei: angenommen, „bereits vorhanden“ (dieselbe Datei wurde schon abgelegt) oder abgelehnt mit Grund (z. B. ZIP-Datei, XML mit DTD, keine UTF-8-Kodierung, keine Rechnung).
- **Per REST oder MCP:** siehe [API.md](API.md#eingangsrechnungen) und [MCP.md](MCP.md#eingangsrechnungen). Dateien bis 15 MB (MCP: 2 MB).
- **Erkannt werden:** XML nach UBL oder CII (XRechnung, EN 16931), PDF mit eingebetteter XML (ZUGFeRD, Factur-X) und sonstige PDF oder Bilder. Ein PDF ohne eingebettete Rechnungsdaten ist eine „sonstige Rechnung“, keine E-Rechnung.
- Die Datei wird unverändert und unveränderlich abgelegt (SHA-256) und **nie gelöscht**. Auch eine fehlerhafte oder irrtümlich abgelegte Datei bleibt aufbewahrt.

### Liste und Prüfstatus

Die Liste zeigt neueste zuerst Lieferant, Rechnungsnummer, Datum, Betrag, Art (z. B. „PDF mit CII · EN 16931“) und den Prüfstatus; die Reiter filtern nach Status:

| Status | Bedeutung |
|---|---|
| wird geprüft | Die Prüfung läuft oder wartet; der Status wechselt nach wenigen Sekunden (Seite neu laden). |
| gültig | Schema, EN 16931 und XRechnung ohne Befund. |
| gültig mit Hinweisen | Nur Warnungen. |
| fehlerhaft | Mindestens ein Fehler gegen Schema oder Regeln; die Befunde stehen in der Detailansicht. Die Datei bleibt abgelegt. |
| nicht geprüft | Die Prüfung war nicht möglich (Zeit, Speicher, Profil ohne Prüfregeln, Prüfer nicht verfügbar, mehr als 5.000 Positionen). Der Grund steht im Ergebnis; mit „Erneut prüfen“ lässt sich die Prüfung wiederholen. |
| keine vollständige E-Rechnung | Sonstige Rechnung (PDF/Bild ohne XML) oder ein Profil unterhalb von EN 16931 (MINIMUM, BASIC WL, ZUGFeRD 1.0); wird nur gekennzeichnet. |

„Gültig“ heißt: formal in Ordnung. Ob Leistung, Preise, Steuersatz, Lieferant und Bankverbindung stimmen, prüft die Anwendung nicht.

### Detailansicht und Druckansicht

- **Lesefassung:** Lieferant und Empfänger, Rechnungsdaten, Positionen, Steuern, Summen (mit rechnerischer Gegenprobe), Zahlungsangaben und Hinweise zur Datei. Eine Rechnung vom Typ 389 trägt den Hinweis, dass sie vom Kunden über deine Leistung ausgestellt wurde; MINIMUM-Profile sind gekennzeichnet. Texte aus der Datei erscheinen nur als Text. Maßgeblich bleibt die Originaldatei.
- **Prüfergebnis:** Befunde mit Regel, Stelle und Text, Prüfer und Version, Zeitpunkt. Jede Prüfung wird als eigene Zeile festgehalten; „Erneut prüfen“ (höchstens 10 je Minute) ergänzt eine weitere.
- **Dateien:** Originaldatei, Rechnungs-XML und eingebettete Anlagen als Download. Vor der Ausgabe wird die Datei gegen ihre Prüfsumme geprüft.
- **Druckansicht:** eine druckbare Fassung der Lesefassung samt Prüfergebnis (Browser-Druck).

### Bearbeiten und freigeben

Jede Eingangsrechnung hat einen Bearbeitungsstatus: **Neu**, **Geprüft**, **Freigegeben**, **Bezahlt** oder **Abgelehnt**. Die Reiter der Liste filtern danach; „Fällig (7 Tage)“ zeigt offene Rechnungen, die bis heute plus 7 Tage fällig sind, überfällige mit dem Vermerk „überfällig“. Über der Liste wählst du zusätzlich den Prüfstatus.

- **Weiterschalten:** Neu → Geprüft → Freigegeben → Bezahlt. „Bezahlt“ ist nur ein **Merker** mit Zahltag (nicht in der Zukunft) und optionalem Vermerk. Die Anwendung bucht nichts, führt keine Überweisung aus und verbindet die Rechnung nicht mit Zahlungen oder dem Bankabgleich.
- **Ablehnen und zurücksetzen** verlangen einen Grund (3 bis 500 Zeichen). Abgelehnt ist der Weg für irrtümlich oder doppelt abgelegte Rechnungen: Gelöscht wird nie, die Datei bleibt aufbewahrt. „Zurücksetzen“ führt einen Schritt zurück (aus „Abgelehnt“ nach „Neu“).
- Jede Änderung steht mit Zeitpunkt im **Änderungsprotokoll**; die Begründungen sind Teil davon.
- **Interne Notiz:** im Detail erfassbar, erscheint nie in Liste, Druckansicht, Exporten oder Mails. Im Änderungsprotokoll steht nur eine Prüfsumme mit der Länge.

### Lieferant zuordnen

Im Detail ordnest du die Rechnung einem vorhandenen **Kontakt** zu (Auswahl mit Suche; Vorschläge nach USt-IdNr. oder Name) oder legst aus den Angaben der Rechnung einen neuen an. Fehlt etwas Pflichtiges (z. B. das Land), fragt das Formular nach; geraten wird nichts. Die Zuordnung ist in „Neu“ und „Geprüft“ änderbar. Die Liste lässt sich nach dem zugeordneten Kontakt filtern.

### Kopfdaten von Hand

Liefert die Datei weder Rechnungsnummer noch Betrag (sonstige PDF oder Bilder, nicht auslesbare E-Rechnung), erfasst du Lieferant, Nummer, Datum, Bruttobetrag, Währung und Fälligkeit selbst. Die Angaben sind als „von Hand erfasst“ gekennzeichnet. Liefert die Datei die Daten, bleibt sie maßgeblich und die Erfassung ist gesperrt.

### Zahlung prüfen

Das Detail zeigt Empfänger, IBAN, BIC und Verwendungszweck aus der Rechnung, die Fälligkeit und die Skontostufen (bis, Satz, Abzug, Zahlbetrag). Dazu:

- **GiroCode** (EPC-QR) für die Überweisung in Euro, bei Skonto je Stufe bis zum Fristtag zusätzlich. Kein GiroCode bei Fremdwährung, Lastschrift, Karte, Verrechnung mit Gutschrift oder ungültiger IBAN; der Grund steht dabei.
- **Warnung bei geänderter IBAN:** Weicht die IBAN von der letzten Rechnung desselben Lieferanten ab, erscheint eine deutliche Warnung mit der früheren IBAN; die neue Bankverbindung ist beim Lieferanten bestätigen zu lassen (bekanntes Betrugsmuster). Liegt keine frühere IBAN vor, steht ein Hinweis, dass kein Vergleich möglich ist.
- Die Anwendung veranlasst keine Zahlung. Du überweist selbst in deinem Online-Banking.

### Benachrichtigung zur Fälligkeit

Die Glocke meldet „Eingangsrechnung fällig“ ab 3 Tage vor der Fälligkeit und einmal bei Überfälligkeit (nur offene Rechnungen: Neu, Geprüft, Freigegeben). Die Meldung lässt sich unter Einstellungen → Benachrichtigungen abwählen; sie enthält keine Notiz.

### Übergabe an die Buchhaltung

Im Menü „Eingang“ wählst du einen Zeitraum nach Eingangsdatum (höchstens 366 Tage) und lädst ein **ZIP** mit den Originalen (`belege/`, bei Hybrid-Rechnungen auch die XML), der Tabelle `eingangsrechnungen.csv` und einer Lies-mich-Datei. Abgelehnte Rechnungen sind nur auf Wunsch dabei. Das ZIP enthält keine internen Notizen und keine Zahlungsvermerke; Grenzen: 2.000 Dateien, 500 MB. Auch der **Prüferexport** (Einstellungen → Prüfung) enthält die Eingangsrechnungen mit Originalen im Ordner `eingang/`.

REST und MCP bieten dieselben Schritte: [API.md](API.md#eingangsrechnungen), [MCP.md](MCP.md#eingangsrechnungen).

### Rechnungen aus einem Postfach abrufen (optional)

Die Anwendung kann ein **eigens für Rechnungen eingerichtetes** Postfach per IMAP abrufen. Das ist standardmäßig ausgeschaltet. Verwende kein Postfach mit privater oder allgemeiner Post: Es werden zwar nur Anlagen gelesen, aber ungelesene Mails werden als gelesen markiert. Mails werden **nie gelöscht oder verschoben**.

1. **Einrichten:** Einstellungen → **Rechnungs-Postfach**. Trage Server, Port (993 mit TLS oder 143 mit STARTTLS), Benutzer, Passwort bzw. App-Passwort, Ordner (Standard INBOX), Abrufbeginn und Absender-Domains ein (eine je Zeile, dringend empfohlen). Postfächer, die nur eine OAuth-Anmeldung erlauben, funktionieren nicht. Das Passwort wird nie angezeigt und nie vorbefüllt; ändern sich Server, Port, Sicherheit oder Benutzer, wird das gespeicherte Passwort entfernt und muss neu eingegeben werden.
2. **Testen und einschalten:** „Verbindung testen“ geht nur zum gespeicherten Server. Erst nach einem erfolgreichen Test lässt sich „Einschalten“ wählen. Abgerufen wird im Takt des Schedulers (Standard alle 15 Minuten) oder sofort mit „Jetzt abrufen“. Die Verbindung nach außen läuft nur über Port 993 oder 143; Betreiberhinweise in [BETRIEB-VORLAGE.md](BETRIEB-VORLAGE.md).
3. **Sichten:** Anlagen (XML und PDF) ungelesener Mails erscheinen unter Eingang → **Postfach** in den Reitern „Zu sichten“, „Übernommen“, „Verworfen“ und „Übersprungen“ (mit Grund, z. B. Dateityp oder Größe, und doppelte Dateien; auch Mails, die zu groß oder nicht lesbar sind, stehen dort und lösen eine Benachrichtigung aus). Jede Zeile zeigt Absender-Domain, Betreff, Dateiname und eine Vorschau. Die Absender-Domain ist eine Angabe der Mail und nicht geprüft.
4. **Entscheiden:** „Übernehmen“ legt die Datei wie ein Upload als Eingangsrechnung ab (unveränderlich, Prüfung, Herkunft sichtbar); mehrere markierte Anlagen lassen sich gemeinsam übernehmen. „Verwerfen“ (mit Bestätigung und optionalem Grund) entfernt die Anlage aus der Sichtung; bis 30 Tage danach holt „Wiederherstellen“ sie zurück, später wird die Kopie entfernt (die Mail bleibt im Postfach). Alle Entscheidungen stehen im Aktivitätsprotokoll.
5. **Herkunft:** Eine übernommene Eingangsrechnung zeigt im Detail „per E-Mail empfangen am …, abgerufen am …, Absender-Domain …“ und den Kanal „Postfach“.

Ist die Sichtung voll (500 Anlagen oder 2 GB), pausiert der Abruf, bis Anlagen entschieden sind. Je Absender-Domain werden in 24 Stunden höchstens 50 neue Mails aufgenommen; weitere bleiben ungelesen und werden später abgerufen. Grenzen: [LIMITATIONEN.md](LIMITATIONEN.md#eingangsrechnungen). Dieselben Schritte bieten REST und MCP ([API.md](API.md#rechnungs-postfach), [MCP.md](MCP.md#rechnungs-postfach)); Einrichtung und Abruf nur in der Oberfläche.

### Weitere Hinweise

- **Mögliche Dublette:** Dieselbe Rechnungsnummer desselben Lieferanten in einer anderen Datei wird angenommen und gekennzeichnet.
- **Prüfer abschalten oder fehlt:** Mit `INCOMING_VALIDATION=off` entfällt die Prüfung (Status „nicht geprüft“); Betriebshinweise in [BETRIEB-VORLAGE.md](BETRIEB-VORLAGE.md).
- Grenzen: [LIMITATIONEN.md](LIMITATIONEN.md#eingangsrechnungen), rechtlicher Hintergrund: [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 4.

## 2d. Konten automatisch abrufen (`Einstellungen → Kontoabruf`)

Optional und ab Werk **aus**. Die Anwendung ruft Umsätze deiner **eigenen** Konten per FinTS 3.0 (PIN/TAN) ab und legt sie in den Bankabgleich (`Bankabgleich`, Herkunft „Kontoabruf“). Sie liest nur; sie sendet nie Überweisungen oder Lastschriften. Gebucht wird weiterhin erst nach deiner Bestätigung.

1. **Produkt-ID beantragen:** FinTS-Zugänge sind registrierten Produkten vorbehalten. Beantrage die Nummer kostenlos bei der Deutschen Kreditwirtschaft (fints.org → Hersteller → Produktregistrierung, Kategorie Web-Server, Bearbeitung etwa 10 bis 15 Werktage) und trage sie unter Einstellungen → Kontoabruf ein. Sie gehört zu deiner Installation und wird nicht weitergegeben. Ohne sie ist die Einrichtung gesperrt.
2. **Bankzugang einrichten:** Bankleitzahl, FinTS-Adresse (steht in den Hilfeseiten deiner Bank; nur `https`), Anmeldename und gegebenenfalls Kunden-ID eintragen, PIN eingeben, TAN-Verfahren wählen und die Konten auswählen, die abgerufen werden sollen. Die PIN wird nie angezeigt. Ändern sich Bankleitzahl, Adresse oder Anmeldename, wird die gespeicherte PIN entfernt und der automatische Abruf ausgeschaltet. „Entfernen“ archiviert den Zugang (das Protokoll bleibt).
3. **PIN-Modus:** Standard ist „PIN je Abruf“: Die PIN wird bei jedem manuellen Abruf eingegeben, während einer offenen Freigabe höchstens 5 Minuten im Arbeitsspeicher gehalten und nie gespeichert; einen automatischen Abruf gibt es dann nicht. „PIN speichern“ legt sie verschlüsselt ab (Schlüssel aus `AUTH_SECRET`) und ist Voraussetzung für den täglichen Abruf; du bestätigst dabei, dass die PIN mit einer TAN auch Zahlungen in deinem Online-Banking erlaubt, dieses Programm aber nur Abfragen sendet. Wird `AUTH_SECRET` geändert, muss die PIN neu eingegeben werden.
4. **Freigabe:** Die Bank verlangt beim ersten Zugriff und spätestens alle 180 Tage eine starke Kundenauthentifizierung, darf aber auch früher fragen. Beim manuellen Abruf führt dich der Freigabe-Dialog: entweder Freigabe in der Banking-App (die Seite wartet) oder Eingabe einer TAN (Text oder Bild). chipTAN mit Flickercode wird nicht angeboten. Eine falsche TAN wird nicht automatisch wiederholt.
5. **Täglicher Abruf:** Mit gespeicherter PIN und Status „Bereit“ schaltest du „Täglich automatisch abrufen“ ein. Der Lauf holt die letzten Tage (höchstens 89) und wartet nie auf eine Freigabe. Verlangt die Bank eine, endet der Lauf mit einer Benachrichtigung „Kontoabruf braucht Ihre Freigabe“; ein manueller Abruf nimmt den täglichen Lauf wieder auf. Etwa 10 Tage vor Ablauf der 180 Tage erinnert eine Benachrichtigung („spätestens bis …“). Ein Hinweis erscheint, wenn Umsätze älter als 89 Tage fehlen: dann manuell mit Freigabe abrufen oder die Datei hochladen.
6. **Abgelehnte PIN:** Lehnt die Bank die Anmeldung ab, wird die PIN gelöscht und der automatische Abruf ausgeschaltet; dieselbe PIN wird nie erneut gesendet, damit die Bank den Zugang nicht sperrt. Prüfe die PIN; bei einer Sperre lässt du den Zugang zuerst bei der Bank entsperren und bestätigst das in der Anwendung. Auch bei einem unklaren Fehler beim Anmelden schaltet sich der automatische Abruf aus; erlaubt ist dann genau ein weiterer manueller Versuch nach ausdrücklicher Bestätigung.
7. **Protokoll:** Die letzten 50 Abrufe stehen mit Zeitraum, Ergebnis, neuen Umsätzen und Dubletten unter Einstellungen → Kontoabruf; der Link führt zum Import im Bankabgleich. Bank-Meldetexte, PIN und TAN werden nie gespeichert.

Der Abruf ersetzt nicht den Kontoauszug der Bank (siehe LIMITATIONEN). Status und Protokoll sind auch per REST und MCP lesbar; Einrichtung und Abruf gibt es nur in der Oberfläche.

## 3. Wichtige Begriffe

| Begriff | Bedeutung |
|---|---|
| **Entwurf** | Editier-/löschbar, keine Nummer. Hier passiert das Erfassen. |
| **Festgeschrieben** | Unveränderbar, Nummer vergeben. GoBD-konform. |
| **Storno** | Eine festgeschriebene Rechnung wird nicht gelöscht, sondern durch eine **Storno-Gutschrift** neutralisiert. Das Original bleibt erhalten. |
| **Nummernkreis** | Fortlaufende, einmalige Nummern. Verworfene Entwürfe verbrauchen **keine** Nummer. |
| **Abo** | Vorlage, aus der nach Plan Rechnungs-Entwürfe (oder direkt festgeschriebene Rechnungen) entstehen. Das Abo selbst ist kein Beleg. |
| **Verzugszins** | Zins ab Stufe 1 der Mahnung nach § 288 BGB (Basiszins + 5 Pp B2C / 9 Pp B2B), taggenau auf den offenen Betrag. |

---

## 4. E-Rechnung — was du wissen musst

- Seit **2025** musst du im B2B E-Rechnungen **empfangen** können (Ablage und Prüfung: „Eingang“, Abschnitt 2c); **versenden** wird ab 2027/2028 Pflicht (Details + Quellen: [COMPLIANCE.md](../COMPLIANCE.md)).
- Der **XRechnung-XML-Teil ist führend** — das PDF ist nur die menschenlesbare Beilage.
- Die App validiert jede XRechnung gegen die EN-16931-Kernregeln, bevor sie ausgeliefert wird. Die vollständige amtliche Prüfung (KoSIT-Validator) läuft im CI.
- **ZUGFeRD/Factur-X** (PDF/A-3b mit eingebettetem XML) erzeugt die App selbst; jedes Rechnungs-PDF außer Entwürfen enthält die XML.

### Steuerschemata und Pflichthinweise

Im Beleg-Editor wählst du unter „Steuerschema" eine von **acht** Optionen — Details, Normen und Fixtures dazu stehen in [COMPLIANCE.md](../COMPLIANCE.md) § 1, 8 und 9:

| Auswahl im Editor | Bedeutung |
|---|---|
| Regelbesteuerung | Normalfall, 19 %/7 %. Kein Pflichthinweis. |
| Kleinunternehmer (§ 19) | Kein USt-Ausweis; Pflichthinweis wird eingefügt. |
| Differenzbesteuerung (§ 25a) | Gebrauchtwaren/Kunst/Sammlerstücke; kein USt-Ausweis, Marge nicht sichtbar. |
| Reverse Charge (§ 13b) | Steuerschuld geht auf den Empfänger über; braucht dessen USt-IdNr. |
| Innergem. Lieferung (§ 6a) | Steuerfreie EU-Warenlieferung; braucht USt-IdNr. beider Seiten + Leistungsdatum/-zeitraum. |
| Innergem. Leistung (§ 3a Abs. 2) | Steuerschuld beim EU-Empfänger; braucht USt-IdNr. beider Seiten. |
| Ausfuhrlieferung (§ 6) | Steuerfreie **Warenlieferung** außerhalb der EU; Empfänger muss außerhalb der EU liegen. |
| Nicht steuerbar, Drittland-Leistung (§ 3a Abs. 2/4/5) | **Dienstleistungen** an Unternehmer im Drittland (§ 3a Abs. 2 UStG) oder an Privatkunden im Drittland, soweit elektronische Leistungen (§ 3a Abs. 5 S. 2 Nr. 3, z. B. Hosting) bzw. Katalogleistungen (§ 3a Abs. 4); sonstige B2C-Leistungen bleiben in Deutschland steuerbar (dann „Regelbesteuerung"). Nur für Empfänger außerhalb der EU: Leistungsort außerhalb Deutschlands, Kategorie O, 0 %, Pflichthinweis wird eingefügt. Alle Positionen müssen Kategorie O tragen; in der E-Rechnung entfallen USt-IdNr.-Angaben (EN 16931 BR-O-02). |

**Land und Steuerhinweis im PDF:** Der Landesname des Kunden (deutsch, Großbuchstaben, z. B. „AUSTRALIEN" oder „DEUTSCHLAND") steht immer als letzte Anschriftszeile in Rechnung, Angebot, Lieferschein und Mahnung; das Land der eigenen Firma steht in der Absenderzeile und in der Fußzeile. Bei 0-%-Positionen druckt das PDF zusätzlich den Grund der Steuerfreiheit/Nichtsteuerbarkeit je Steuerkategorie, auch bei Regelbesteuerung.

**Pflichthinweis:** Sobald du ein Schema mit Pflichthinweis wählst, erscheint unter dem Feld „Hinweis / Notiz" der Text, der beim Festschreiben verlangt wird, sowie — falls der aktuelle Hinweistext nicht (mehr) passt — der Button **„Pflichthinweis einfügen"**, der ihn automatisch ergänzt. Die Prüfung ist wortgenau (kleine Abweichungen wie Groß-/Kleinschreibung oder mehrfache Leerzeichen sind egal, ein anderer Text nicht).

**Was zusätzlich das Festschreiben blockiert** (reine Hinweistexte genügen nicht mehr):

- **Innergem. Lieferung:** Leistungsdatum **oder** Leistungszeitraum muss gesetzt sein, **und** die USt-IdNr. des Kunden muss aus einem anderen EU-Land stammen (keine deutsche, keine Nicht-EU-USt-IdNr.).
- **Reverse Charge:** der Kunde braucht eine USt-IdNr.
- **Ausfuhrlieferung:** das Land des Kunden muss außerhalb der EU liegen.
- Bei allen Schemata mit Pflichthinweis (außer Regelbesteuerung) dürfen die Positionen keinen USt-Satz > 0 % haben.

**Den § 25a-Hinweistext austauschen:** Der voreingetragene Text „Gebrauchtgegenstände/Sonderregelung" passt für die meisten Fälle. Geht es stattdessen um Kunstgegenstände oder um Sammlungsstücke/Antiquitäten, überschreibst du das Feld „Hinweis / Notiz" von Hand mit „Kunstgegenstände/Sonderregelung" bzw. „Sammlungsstücke und Antiquitäten/Sonderregelung" — beide sind ebenso gültig (§ 14a Abs. 6 UStG).

**§ 14b-Hinweis (Aufbewahrungspflicht des Kunden):** Bei einer Rechnung über eine grundstücksbezogene Bauleistung an eine **Privatperson** setzt du zusätzlich den Schalter „Hinweis auf Aufbewahrungspflicht (§ 14b)" in den weiteren Optionen — die Software erkennt das nicht automatisch (keine Leistungsart-/Kundentyp-Erkennung). Der Hinweis erscheint dann im PDF sowie in XRechnung und ZUGFeRD.

---

## 5. Datensicherung & Betrieb

- **Backup**: Die SQLite-Datei `prisma/dev.db` (bzw. die PostgreSQL-Datenbank) regelmäßig sichern. Aufbewahrungsfrist beachten (siehe COMPLIANCE.md).
- **Mehrbenutzer/Internet**: Die App hat eine eingebaute Anmeldung (ein Admin-Konto, siehe „Anmeldung & Konto" oben) — aber **keine Mehrbenutzer-/Rollentrennung**. Betreibe sie in Produktion **immer** hinter HTTPS mit gesetztem `AUTH_SECRET`. Siehe [SECURITY.md](../SECURITY.md).
- **PostgreSQL/Docker**: `docker compose up -d` mit dem fertigen Image `ghcr.io/c-sakel/open-invoice-germany` (siehe README, Abschnitt „Mit Docker“).
- **API-Dokumentation im Container**: `/api/docs` (Swagger UI) und `GET /api/v1/openapi.json` lesen die committete Datei `openapi/openapi.json` zur Laufzeit relativ zu `process.cwd()`. Im Docker-Image legt das Next.js-Tracing sie im Standalone-Output ab; der Build bricht ab, wenn sie (oder eine andere zur Laufzeit gelesene Datei) dort fehlt.

### Prüfung & Export (`Einstellungen → Prüfung`)
- **Kettenprüfung:** Das Änderungsprotokoll ist hash-verkettet. Der Scheduler prüft wöchentlich; „Jetzt prüfen“ startet sofort und zeigt „gültig“ oder die Bruchstelle. Bei einem Bruch erscheint ein Alarm, der sich nicht abschalten lässt.
- **Prüfer-Export:** Zeitraum wählen (höchstens 3 Jahre) und das ZIP laden (CSV-Tabellen, `index.xml`, Kettenprüfung, archivierte Belege) — für die Datenträgerüberlassung an die Betriebsprüfung. Nicht in Excel o. Ä. öffnen, sondern an den Prüfer bzw. Steuerberater weitergeben (`liesmich.txt` im ZIP). `index.xml` vorab vom Steuerberater abnehmen lassen.
- **Belegansicht:** festgeschriebene Rechnungen zeigen „Archiviert am …“; ab dann liefern PDF und XML immer exakt den archivierten Stand.
- **Datensicherung:** Vorlage und Restore-Test siehe [BETRIEB-VORLAGE.md](BETRIEB-VORLAGE.md); gesichert werden Datenbank, Anhänge, Belegarchiv und `.env`. Das Offsite-Ziel legt der Betreiber fest.

---

## 6. Briefpapier, Layouts, Nummernkreise, Druckoptionen & GiroCode

Unter **„Einstellungen"** findest du zusätzliche Seiten für das Erscheinungsbild und die Nummerierung deiner Belege; das Erscheinungsbild ist in die Reiter „Briefpapier" / „Layouts" / „Druckoptionen" unter `Einstellungen → Briefpapier` aufgeteilt.

### Briefpapier einrichten (Reiter „Briefpapier")
- **Logo hochladen**: PNG oder JPEG, max. **2 MB**. Wird je nach Layout oben rechts oder oben links auf jedem Beleg-PDF angezeigt.
- **Logogröße**: Schieberegler + Zahlenfeld „Breite im PDF (mm)", 10–140 mm. Die Höhe wird automatisch auf 35 mm begrenzt (und so, dass das Logo bei 45 mm von oben endet; bei großem oberen Rand wird es entsprechend kleiner) — ein breites/flaches Logo wird bis zu dieser Breite groß, ein hohes/schmales Logo wird schon vorher durch die Höhengrenze gebremst, damit es nicht in den Adressblock hineinläuft. **Ausnahme Layout „modern"**: dort ist das Logo zusätzlich auf die Höhe des Kopfbalkens begrenzt (≈ 15 mm) — ein breites Logo wirkt dort kleiner als in den übrigen Layouts, auch bei hoher eingestellter Breite.
- **Hintergrundbild** (optional): PNG oder JPEG, max. **5 MB**, ganzseitig hinter dem Beleginhalt — nur sichtbar, wenn „Hintergrund anzeigen" aktiv ist.
- **Primärfarbe**, **Ränder** (oben/rechts/unten/links, mm) und **Schriftgröße** (pt) bestimmen Optik.
- **Absenderzeile** (Rücksendeangabe, steht in allen Layouts als unterste Zeile über der Anschrift im Fensterfeld nach DIN 5008 Form B) und Fußzeile (automatisch aus den Stammdaten in vier Spalten, oder drei freie Textfelder links/mittig/rechts).
- **Vorschau**: Link auf der Seite öffnet eine Musterrechnung/-lieferschein mit dem aktuell gespeicherten Layout.
- Änderungen wirken sofort auf **alle** künftigen PDF-Abrufe, auch bei bereits festgeschriebenen Belegen (Nachdruck) — der rechtlich maßgebliche Beleginhalt (Zahlen, Positionen, Nummer) bleibt davon unberührt (siehe [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 6).

### Layouts (Reiter „Layouts")
Sieben fest vorgegebene PDF-Layouts (**standard**, **schlicht**, **klassik**, **modern**, **blau**, **schwarz**, **kompakt**) — je eine Vorschaukachel. Die Auswahl gilt **je Belegtyp** (Rechnung, Angebot, Auftragsbestätigung, Proforma, Gutschrift, Lieferschein, Mahnung) und zusätzlich als **Organisationsstandard** (Fallback für Belegtypen ohne eigene Zuordnung) — es ist also **kein** einziges Layout mehr org-weit fest, sondern eine Auflösungsreihenfolge: Beleg-Override (im Editor gesetzt) **>** Typ-Zuordnung **>** Organisationsstandard **>** „standard". Ein Kachel-Klick ändert zunächst nur eine lokale Vorschau; „Für <Typ> übernehmen" bzw. „Als Standard für alle" speichert die Auswahl erst explizit. Zusätzlich lässt sich auf einem einzelnen **Entwurf** im Editor unter „Weitere Optionen" ein abweichendes Layout nur für diesen einen Beleg wählen — beim Festschreiben wird diese Wahl eingefroren und ändert sich danach nicht mehr, auch wenn du später den Organisationsstandard/die Typ-Zuordnung änderst (Nachdrucke bleiben stabil).

### Layout-Designer (`Einstellungen → Briefpapier → Designer`)
Für eigene Layouts: Name vergeben, optional **„Aus Vorlage“** wählen (übernimmt eines der sieben festen Layouts; bei ungespeicherten Änderungen fragt der Designer vorher nach). Danach lassen sich die **Blöcke** hinter den fest stehenden Kopfblöcken (Absender, Empfänger, Belegdaten nach DIN 5008) — Betreff, Einleitungstext, Positionen, Summen, GiroCode (optional), Fußtext, Zahlungshinweise — per Maus oder Tastatur umsortieren; Betreff, Einleitungstext und Fußtext bestimmen nur die Stelle, vorhandener Text wird immer gedruckt (PDF = XML-Inhalt), **Spalten** der Positionstabelle ein-/ausblenden und in der Breite anpassen, **Schrift** (Liberation Sans, IBM Plex Sans, IBM Plex Serif, Source Serif 4, Inter), Größen, **Farben** und die Kopf-/Fußzone einstellen. Pflichtangaben (Absender, Empfänger, Belegdaten, Positionen, Summen, Zahlungshinweise; Spalten Beschreibung, Menge, Gesamt) lassen sich nicht abschalten. Ist die Fußzeile ausgeblendet oder auf „Eigener Text“ gestellt, erscheinen Steuernummer und USt-IdNr des Leistenden automatisch in den Belegdaten (§ 14 Abs. 4 Nr. 2 UStG). Ungespeicherte Änderungen schützt der Designer beim Verlassen der Seite mit einer Rückfrage. Rechts zeigt eine **Live-Vorschau** das PDF (Beleg­typ und Entwurf wählbar). **Speichern** erzeugt bei geänderter Konfiguration eine neue, unveränderliche **Version**; frühere Versionen stehen in der Versionsliste und lassen sich in der Vorschau ansehen. Die **Zuordnung je Belegtyp** erfolgt im Reiter „Layouts“ (Design als Auswahl neben den festen Layouts). Beim Festschreiben (bzw. bei Angebot/AB/Proforma beim ersten Verlassen des Entwurfs, beim Lieferschein bei Vergabe der Nummer, bei Mahnung bei der Erstellung) wird die aktuelle Version am Beleg eingefroren — spätere Änderungen am Design wirken nicht mehr auf diesen Beleg. Ein zugeordnetes Design lässt sich nicht archivieren. Die Empfängerschrift im Anschriftfenster beträgt mindestens 8 pt; Designs, in denen eine sechszeilige Anschrift nicht ins Fenster passt, werden abgelehnt. Grenzen: siehe [LIMITATIONEN.md](LIMITATIONEN.md).

### Nummernkreise (`Einstellungen → Nummernkreise`)
Tabelle mit **neun** Nummernkreisen: Angebote, Auftragsbestätigungen, Proforma-Rechnungen, Lieferscheine, Rechnungen, Gutschriften, Mahnungen sowie **Kundennummern** und **Artikelnummern**. Je Zeile editierbar:
- **Muster** — z. B. `RE-{YYYY}-{SEQ:5}` (Jahr + 5-stellig auf 0 aufgefüllt) oder `KD-{SEQ:5}` (ohne Jahr). Der Platzhalter `{SEQ}`/`{SEQ:n}` ist Pflicht.
- **Präfix**, **Nachkommastellen der laufenden Nummer** (Padding), **jahresabhängig zurücksetzen** (an/aus).
- **Nächste Nummer** — die App zeigt zur Kontrolle eine Vorschau der als Nächstes vergebenen Nummer.
- **Zurückdrehen ist gesperrt**: eine bereits vergebene Nummer kann nicht erneut ausgegeben werden (GoBD/§ 14 Abs. 4 Nr. 4 UStG für Rechnungen; bei den übrigen Nummernkreisen aus Nachvollziehbarkeitsgründen ebenso gesperrt). Jede Änderung wird protokolliert.
- Rechnungs-/Gutschriftnummern bleiben weiterhin **erst beim Festschreiben** vergeben; Angebots-/AB-/Lieferschein- sowie Kunden-/Artikelnummern **bei Erstellung** — siehe [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 6.

### Druckoptionen (Reiter „Druckoptionen")
Zehn globale Schalter für Beleg-PDFs: Fußzeile, Seitenzahlen, Falz-/Lochmarken (DIN 5008), Artikelnummer-/Beschreibungs-/Steuersatz-/Zeilensummen-Spalte, Absenderzeile, **GiroCode**. Auf einem einzelnen **Entwurf** (Rechnung/Angebot/Lieferschein) lässt sich im Editor unter „Weitere Optionen" gezielt von den globalen Werten abweichen — nur die tatsächlich angehakten Felder werden je Beleg überschrieben. Nach dem Festschreiben ist diese Beleg-Auswahl nicht mehr änderbar.

### GiroCode-Größe
Neben dem Schalter „GiroCode anzeigen" legt **„GiroCode-Größe (mm)"** unter **Einstellungen → Briefpapier → Druckoptionen** die Kantenlänge des QR-Codes fest — **15–40 mm**, Standard **22 mm**; unter 15 mm ist der Code in Banking-Apps nicht mehr zuverlässig scanbar. Wie die übrigen Druckoptionen lässt sich der Wert auf einem einzelnen **Entwurf** im Editor unter „Weitere Optionen" gezielt überschreiben; nach dem Festschreiben ist diese Beleg-Auswahl eingefroren und ändert sich nicht mehr rückwirkend.

### GiroCode-Voraussetzungen
Der GiroCode (QR-Code für „Scannen & Bezahlen" in Banking-Apps, Standard EPC069-12) erscheint auf einer Rechnung nur, wenn **alle** Punkte erfüllt sind:
- „GiroCode anzeigen" ist unter **Druckoptionen** aktiv,
- eine **IBAN** ist hinterlegt (Organisation oder Zahlungsmethode),
- die Rechnungswährung ist **EUR**,
- es besteht noch ein **offener Betrag** (> 0 €),
- der Belegtyp ist zahlungsrelevant (reguläre Rechnung, Teil-/Abschlags-/Schlussrechnung, Korrektur — nicht Gutschrift).
Fehlt eine Voraussetzung, erscheint der Beleg einfach **ohne** GiroCode — kein Fehler, kein blockierter Druck.

---

## 6a. Kundenkomfort — Adressen, Ansprechpartner, Kundenfelder, Letztes Dokument übernehmen

Auf der Kunden-Detailseite (`Kunden → <Kunde>`) gibt es vier zusätzliche Reiter.

### Adressen (Reiter „Adressen")
Ein Kunde kann beliebig viele Adressen führen — jede vom Typ **Rechnung**, **Lieferung** oder **Sonstige**, mit optionalem Label (z. B. „Zweigstelle Nord"). Über „Als Standard setzen" legst du je Typ genau eine Standardadresse fest — diese wird bei einer neuen Rechnung/einem neuen Angebot automatisch vorbelegt (aber jederzeit im Formular überschreibbar). Löschen entfernt nur die Adresse selbst; bereits erstellte Belege behalten ihren eingefrorenen Adress-Snapshot unverändert.

### Ansprechpartner (Reiter „Ansprechpartner")
Analog zu Adressen, aber kundenweit ein Standard (nicht je Typ). Vorname/Nachname sind Pflicht, Rolle/Telefon/Mobil/E-Mail optional. Der Standard-Ansprechpartner erscheint als Vorbelegung in Beleg-Formularen und wird beim Anlegen als Snapshot eingefroren — spätere Änderungen am Ansprechpartner wirken nicht auf bereits erstellte Belege zurück. In PDF-Kopf-/Fußtexten und E-Mail-Vorlagen stehen die Platzhalter `{{contact.firstName}}`, `{{contact.lastName}}`, `{{contact.role}}`, `{{contact.email}}`, `{{contact.phone}}` zur Verfügung.

### Vorgaben (Reiter „Vorgaben")
Zehn kundenspezifische Vorgaben, die bei einer neuen Rechnung/einem neuen Angebot automatisch greifen, sofern das Formular das Feld nicht selbst befüllt (Priorität: **deine Eingabe > Kundenvorgabe > Zahlungsmethode/Einstellungen > Systemdefault**): Standardwährung, Standard-Rabatt (Promille), Rechnungs-/Angebots-E-Mail + CC (für den Versand), „E-Rechnung bevorzugt" (schaltet die Org-weite Vorbelegung nur ein, nie aus), Standard-Bestellreferenz (wird zu BT-13 in der E-Rechnung), Standard-Liefer-/Zahlungsbedingungstext, Sprache (aktuell nur gespeichert, siehe [LIMITATIONEN.md](LIMITATIONEN.md)). Das Formular ist ein **Vollersatz** — ein leer gelassenes Feld setzt eine vorher gespeicherte Vorgabe zurück.

### Kundenfelder (`Einstellungen → Kundenfelder` + Reiter „Kundenfelder" beim Kunden)
Unter „Einstellungen → Kundenfelder" definierst du organisationsweite, benutzerdefinierte Felder für Kunden: Schlüssel (nur Kleinbuchstaben/Ziffern/Unterstrich, muss mit einem Buchstaben beginnen), Anzeigename, Typ (**Text**, **Zahl**, **Datum**, **Ja/Nein**, **Auswahl** mit bis zu 50 Optionen), Pflichtfeld an/aus, Reihenfolge (per Hoch/Runter). Auf der Kunden-Detailseite trägst du im Reiter „Kundenfelder" die Werte je Kunde ein. Die Werte stehen in Texten/Mail-Vorlagen als `{{customField.<Schlüssel>}}` zur Verfügung. Löschst du eine Definition, bleiben bereits gespeicherte Werte im Hintergrund erhalten (siehe [LIMITATIONEN.md](LIMITATIONEN.md)) — legst du den gleichen Schlüssel erneut an, sind sie wieder sichtbar.

### Letztes Dokument übernehmen (§32)
Ist unter „Einstellungen → Belege" die Option **„Letztes Dokument als Vorlage anbieten"** aktiv, erscheint beim Anlegen einer neuen Rechnung/eines neuen Angebots/einer neuen AB für einen Kunden mit passendem Vorgängerbeleg ein Hinweis „**<Belegart> <Nummer> vom <Datum> übernehmen?**". Du wählst per Checkbox, was übernommen wird: **Positionen**, **Texte**, **Bedingungen** (Zahlungs-/Lieferbedingungen), **Preise** (nur zusammen mit Positionen wählbar — ohne Positionen gibt es nichts, dessen Preise übernommen werden könnten). „Übernehmen" befüllt das Formular sofort; „Dokument duplizieren" öffnet stattdessen den gefundenen Vorgängerbeleg zum regulären Duplizieren. Interne Notizen werden **nie** übernommen.

---

## 6b. Dashboard, Filter, Schnellaktionen, Benachrichtigungen & Abo-Bearbeiten

### Dashboard (Startseite nach Anmeldung)
Bist du angemeldet, zeigt die Startseite (`/`) statt der Marketingseite dein **Dashboard**: offene, fällige und überfällige Beträge, „fällig diese Woche", teilbezahlte Rechnungen, wie viele Rechnungen ein Mahnschreiben benötigen würden, ein Aging-Diagramm (0–7 / 8–30 / 31–60 / 61–90 / über 90 Tage überfällig), den **Nettoumsatz** im laufenden Monat, die letzten fünf Belege und die Anzahl offener Angebote. Das Aging auf dem Dashboard zählt den heutigen Fälligkeitstag bereits mit (Frühwarnung) — die Mahnübersicht unter `/mahnwesen` zählt erst ab dem Folgetag (Eskalationslogik); beide zeigen deshalb bei derselben Rechnung leicht unterschiedliche Buckets, siehe [LIMITATIONEN.md](LIMITATIONEN.md).

**Vier Diagramme, vier verschiedene Bemessungsgrundlagen — bewusst so benannt:**

- „Umsatz je Monat" (Balken, Dashboard) und „Umsatz je Monat" (Linie, Kundenseite) — **Nettoumsatz**, 12 Monate. Dieselbe Grundlage wie die Kachel „Nettoumsatz (laufender Monat)" auf dem Dashboard und „Nettoumsatz" auf der Kundenseite: nur Entwürfe (Status DRAFT) fehlen, ein storniertes Original bleibt mit vollem Betrag in seinem Ausstellungsmonat stehen, die Storno-Gutschrift mindert separat den Monat der Stornierung — über die Zeit gleicht sich das exakt aus (periodengerechte/accrual-Sicht). Gutschriften (auch frei angelegte, nicht nur Stornos) sind bereits mit ihrem negativen Betrag eingerechnet.
- „Top 5 Kunden" (waagerechte Balken, Dashboard) — dieselbe Nettoumsatz-Grundlage, nach Kunde gruppiert.
- **CSV-Export:** Die Karten „Umsatz je Monat", „Zahlungseingang und Rechnungsausgang", „Angebotsquote" und „Top 5 Kunden" auf dem Dashboard sowie „Umsatz je Monat" auf der Kundenseite (nur dieser Kunde) haben einen Link **CSV** (der Umsatz-Link liefert die Standardwährung; über REST/MCP liefert `revenue` ohne Filter je Währung eigene Zeilen). Die Datei öffnet in Excel direkt (UTF-8 mit BOM, Semikolon, Dezimalkomma). Monatsgrenzen der Auswertungen laufen in Berliner Zeit. Die öffentliche Angebotsseite erscheint in der Belegsprache des Angebots (Deutsch oder Englisch).
- „Rechnungsstatus (Anzahl)" (Ring, Dashboard) — zählt **Belege**, keinen Betrag (Offen/Überfällig/Bezahlt).
- „Überfällig nach Alter (offen, brutto)" (waagerechte Balken, Dashboard/Aging) — der **offene Bruttobetrag** je Alters-Bucket, nicht netto und nicht mit der Umsatzreihe zu verwechseln.

Jeder Wert erscheint beim Überfahren mit der Maus als Tooltip (Monat/Kunde + Betrag); unter jedem Diagramm steht dieselben Werte zusätzlich als für Screenreader zugängliche Tabelle (visuell ausgeblendet, aber im Code vorhanden) — die Diagramme sind damit ohne Maus und ohne Sehen bedienbar.

### Status-Tabs, Sofortfilter & Kopfkennzahlen (Rechnungen, Angebote/AB/Proforma, Lieferscheine, Abos)
Jede Listenseite (`/rechnungen`, `/dokumente`, `/lieferscheine`, `/abos`) zeigt oben **Status-Tabs** statt eines Status-Auswahlfelds: ein Klick auf einen Tab (z. B. „Überfällig") filtert sofort, die Zahl neben dem Tab-Namen zeigt, wie viele Belege dort stehen — bezogen auf die übrigen aktiven Filter, unabhängig vom gerade gewählten Tab. Bei Angeboten/Auftragsbestätigungen kommen zwei abgeleitete Tabs hinzu, „Berechnet" und „Teilweise berechnet" — sie zeigen den **Abrechnungsstand** (ob/wieviel bereits in Rechnung gestellt wurde), nicht den Beleg-Status selbst; sie bleiben auch bei sehr vielen Belegverknüpfungen vollständig (große Mengen kosten nur mehr Abfragen, siehe [LIMITATIONEN.md](LIMITATIONEN.md)). Die Status-Tabs überlappen sich bewusst dort, wo es die Statuslogik selbst tut — eine teilbezahlte, überfällige Rechnung erscheint unter „Teilbezahlt" **und** unter „Überfällig".

Die Filterleiste darunter filtert **ohne eigenen „Filtern"-Knopf**: ein Auswahlfeld oder Datum filtert sofort bei Auswahl, Text- und Betragsfelder nach kurzer Tipppause (rund 300 ms) — ganz ohne JavaScript funktioniert sie weiterhin über die Eingabetaste/das Absenden des Formulars, mit demselben Ergebnis (Betrag/Kunde eingeschlossen — die Umrechnung Euro→Cent bzw. Name→Kunde läuft serverseitig, nicht mehr nur im Browser). Verfügbare Filter (je nach Liste): Volltextsuche, Kunde (Namenseingabe — ohne exakten Treffer zählt die Eingabe als Volltextsuche), Belegtyp/-art, Zeitraum (von/bis), bei Rechnungen zusätzlich Betrag in Euro (von/bis), Zahlungsart und E-Rechnung ja/nein. Jeder Filter landet in der URL und lässt sich damit als Lesezeichen speichern oder teilen. Gutschriften findest du über `/rechnungen?type=CREDIT_NOTE` (kein eigener Menüpunkt).

Darunter zeigen **Kopfkennzahlen** die Summe über die **gefilterte Menge** — nicht nur über die gerade angezeigte Seite der Liste: bei Rechnungen Anzahl, Brutto gesamt, Offen und Überfällig; bei Dokumenten Anzahl und Brutto gesamt; bei Lieferscheinen NUR die Anzahl (Lieferscheine sind kein Steuerbeleg und speichern keine Bruttosumme); Abos zeigen keine Kopfkennzahl. Umfasst die gefilterte Menge mehrere Währungen, wird die Summe mit dem Hinweis „gemischte Währungen" gezeigt statt sie stillschweigend zu addieren.

### Fälligkeit & Herkunft
Die Spalte „Fällig" der Rechnungsliste zeigt statt eines nackten Datums eine relative Angabe („in 5 Tagen", „seit 2 Tagen überfällig") — das genaue Datum steht als Tooltip beim Überfahren mit der Maus; bei Überfälligkeit ist der Text dieser Spalte rot. Wurde ein Beleg aus einem anderen erzeugt (z. B. Rechnung aus Angebot/AB, Lieferschein aus Angebot/AB/Rechnung, Rechnung aus einem Abo), zeigt ein kleiner Link unter der Belegnummer die **Herkunft** (z. B. „aus Angebot AN-2026-0007") — ein Klick führt direkt zum Ursprungsbeleg.

### Zeilen-Schnellaktionen
In jeder Zeile einer Liste öffnet das „⋯"-Menü die für **diesen** Beleg im aktuellen Status verfügbaren Aktionen (öffnen, bearbeiten, duplizieren, PDF, XRechnung, per E-Mail senden/erneut senden, Zahlung buchen, Zahlungserinnerung, nächste Mahnstufe, umwandeln, stornieren) — nicht verfügbare Aktionen erscheinen gar nicht erst, kein Rätselraten über deaktivierte Buttons. Zahlung und Versand lassen sich direkt aus der Liste heraus erledigen, ohne die Detailseite zu öffnen. Bei Angeboten/Auftragsbestätigungen bündelt „Umwandeln" alle möglichen Ziele — Auftragsbestätigung, Rechnung, Lieferschein — in einem Menüpunkt statt mehrerer einzelner Einträge; welche Ziele angeboten werden, hängt vom Status und (nur bei der Rechnungs-Erzeugung) vom Abrechnungsstand ab: eine bereits umgewandelte Vorlage bietet keine weitere Auftragsbestätigungs-/Rechnungs-Erzeugung mehr an, eine bereits voll abgerechnete Vorlage zusätzlich keine weitere Rechnungs-Erzeugung (§13-15 UStG) — ein Lieferschein lässt sich aus einem Angebot/einer AB weiterhin erzeugen, auch nach vollständiger Abrechnung (Liefern nach Rechnungsstellung ist der Normalfall).

### Kundendetailseite
`Kunden → <Kunde>` zeigt jetzt zuerst eine Übersicht: offener Betrag, überfälliger Betrag, Nettoumsatz, letzte Aktivität, sowie Reiter für alle Rechnungen/Angebote/Lieferscheine/Abos dieses Kunden. Die bisherigen Stammdatenformulare (Adressen, Ansprechpartner, Vorgaben, Kundenfelder) findest du unverändert unter „Bearbeiten" auf dieser Seite.

**Zeitreihe, Ø Zahlungsdauer und Pünktlichkeitsanteil:** darunter zeigt
eine Liniengrafik den Netto-Umsatz dieses Kunden über die letzten 12 Monate. Zwei
zusätzliche Kacheln fassen sein Zahlungsverhalten zusammen: „Ø Tage bis zur
Zahlung" (Mittelwert zwischen Rechnungsdatum und der zuletzt erfassten Zahlung über
alle bezahlten Rechnungen dieses Kunden) und „Pünktlichkeit" (Anteil der bis zum
Fälligkeitstag beglichenen Rechnungen — der Fälligkeitstag selbst zählt noch als
pünktlich). Beide zeigen „—" statt eines Werts, wenn es (noch) keine bezahlte
Rechnung bzw. keine mit Fälligkeitsdatum gibt — siehe „Grafiken & Auswertungen" in
[LIMITATIONEN.md](LIMITATIONEN.md).

### Belegseite
Die Detailseite von Rechnung, Angebot/AB/Proforma und Lieferschein teilt sich einen gemeinsamen Rahmen: PDF mittig, Beleg-/Statuskarten rechts.

- **Primäraktion** (Kopfzeile, Rechnungen): statt bis zu fünf gleichwertigen Knöpfen zeigt die Kopfzeile genau **einen** hervorgehobenen Knopf je Status — Entwurf → „Festschreiben", offen → „Als bezahlt markieren" (öffnet den vorbelegten Zahlungsdialog), bezahlt/storniert → „Neue Rechnung". „Neue Rechnung" steht daneben immer als zweiter, unauffälliger Link zur Verfügung, außer er ist bereits die Primäraktion. Bei Angebot/AB/Proforma und Lieferschein zeigt die Kopfzeile stattdessen wie bisher den jeweils ersten verfügbaren Statusübergang (z. B. „Annehmen"); die restlichen Übergänge sowie „Umwandeln" (Auftragsbestätigung/Rechnung/Lieferschein) stehen im „Mehr"-Menü. Der unauffällige Link „Neue Rechnung" (mit vorbelegtem Kunden) steht auf **jeder** Belegseite in der Kopfzeile — auch auf Angebot/AB/Proforma und Lieferschein, nicht nur auf der Rechnungsseite selbst.
- **Zahlungsdialog** (`#zahlung`, nur Rechnungen): „Zahlung erfassen"/„Als bezahlt markieren" öffnen denselben Dialog — vorbelegt mit dem offenen Betrag, dem heutigen Datum und der Standardzahlungsmethode. Gebucht wird **nie** automatisch, erst mit Klick auf „Buchen" im Formular. Ein Link auf `#zahlung` (z. B. aus dem Mahnwesen oder einer Liste) öffnet den Dialog direkt beim Laden der Seite; das ✕ oder Escape schließen ihn wieder, ein erneuter Klick auf denselben Link öffnet ihn erneut.

### Zeitstrahl (Rechnungs-/Angebots-/Lieferschein-Detailseite)
Jede Belegdetailseite zeigt unter „Zeitstrahl" eine chronologische Historie: Anlage, Änderungen, Festschreibung, Versand, Zahlungen, Mahnungen, Statuswechsel, Duplizierung, Umwandlung — alles an einem Ort statt über mehrere Karten verstreut. Für Belege, die vor Einführung des Zeitstrahls angelegt wurden, fehlen entsprechend frühere Ereignisse, siehe [LIMITATIONEN.md](LIMITATIONEN.md).

### OSS-Schwelle für EU-Privatkunden
Verkaufst du an Privatkunden in anderen EU-Ländern (Rechnung ohne USt-IdNr.), summiert die Software deren Nettoumsätze je Kalenderjahr und vergleicht sie mit der EU-weiten Bagatellgrenze von **10.000 €** (§ 3c Abs. 4 UStG). Auf dem **Dashboard** erscheint dazu die Karte „EU-Fernverkäufe / OSS-Schwelle“ mit Fortschrittsbalken, Stand des Jahres und des Vorjahrs sowie den Ländern — sie ist nur sichtbar, wenn es solche Umsätze gibt. Ab der Warnschwelle (Standard 80 %) und beim Überschreiten kommt eine **Benachrichtigung** (Glocke, Typ „OSS-Schwelle“, unter „Einstellungen → Benachrichtigungen“ abschaltbar).
- **Zählweise** (`Einstellungen → Belege`, Abschnitt „EU-Fernverkäufe (OSS-Schwelle)“): „Alle EU-Privatkunden-Umsätze“ (Standard, vorsichtig) oder „Nur Positionen mit OSS-Kategorie“. Dazu die **Warnung ab (%)** (1–99). Hinweis zu „Nur Positionen mit OSS-Kategorie“: Anteils-Teilrechnungen zählen dort nie, Abschläge erst mit der Schlussrechnung und Belege, die vor Einführung der OSS-Kategorie (November 2026) angelegt wurden, gar nicht — für das Einführungsjahr und das Vorjahr gilt die vorsichtige Standard-Zählweise.
- **OSS-Kategorie** am Produkt (`Produkte`): Keine, Fernverkauf von Waren oder Elektronische Dienstleistung. Neue Produkte haben „Keine“; Positionen übernehmen die Kategorie beim Anlegen aus dem Produkt.
- Gutschriften und Stornos mindern die Summe; Fremdwährungsbelege zählen mit ihrem eingefrorenen EUR-Betrag. Fehlt ein EUR-Betrag (Altbeleg), nennt die Karte die Anzahl der nicht gezählten Belege.
- Die Karte ist eine Orientierung, keine steuerliche Beratung; eine OSS-Meldung erzeugt die Software nicht. Grenzen: [LIMITATIONEN.md](LIMITATIONEN.md), Rechtsgrundlage: COMPLIANCE.md § 10.

### Umsatzgrenzen der Kleinunternehmerregelung (§ 19 UStG)
Wendest du die Kleinunternehmerregelung an (Standard-Steuerschema „Kleinunternehmer“ oder Belege mit diesem Schema im Jahr), zeigt das **Dashboard** die Karte „Kleinunternehmerregelung (§ 19 UStG)“: vereinnahmter und berechneter Netto-Umsatz des Jahres und des Vorjahres gegen 25.000 € und 100.000 €. Maßgeblich ist der **vereinnahmte** Umsatz; der berechnete dient nur als Vorwarnung.
- **Einstellungen** (`Einstellungen → Belege`, Abschnitt „Kleinunternehmerregelung (§ 19 UStG)“): Warnung ab (% der Grenze, Standard 80), Jahr der Aufnahme der Tätigkeit (dann gilt im laufenden Jahr die Grenze von 25.000 €) und der **Umsatz außerhalb des Programms** je Jahr (z. B. Vorjahr vor der Einführung oder Barverkäufe).
- **Benachrichtigung** einmal je Jahr und Stufe; beim **Festschreiben** einer Kleinunternehmer-Rechnung erscheint ein Hinweis, wenn die Grenze überschritten ist. Das Steuerschema wird nie automatisch umgestellt.
- Hilfsumsätze und Anlagevermögen erkennt das Programm nicht; die Auswertung ist eine Orientierung, keine steuerliche Beratung (Grenzen: [LIMITATIONEN.md](LIMITATIONEN.md), Rechtsgrundlage: COMPLIANCE.md § 3).

### Kleinbetrag, Ausstellfrist und Verzugshinweis
- **Kleinbetragsrechnung (§ 33 UStDV):** Rechnungen bis 250,00 € brutto tragen im Editor und in der Belegansicht das Kennzeichen „Kleinbetragsrechnung“. Es ist nur eine Kennzeichnung; die Pflichtangaben bleiben unverändert.
- **Ausstellfrist (§ 14a UStG):** Bei ig. Lieferung und ig. Leistung zeigt der Entwurf „Ausstellfrist: bis TT.MM.JJJJ“ (15. Tag des Monats nach der Leistung); nach Fristablauf wird die Angabe rot, und beim Festschreiben erscheint ein Hinweis. Festgeschrieben wird trotzdem.
- **Verzugshinweis für Verbraucher (§ 286 Abs. 3 BGB):** `Einstellungen → Belege`, Abschnitt „Rechnungen an Verbraucher“, Schalter „Verzugshinweis auf Rechnungen an Verbraucher drucken“ (Standard aus). Eingeschaltet gilt er für neue Rechnungen an Kunden vom Typ Verbraucher; im Editor lässt er sich je Rechnung an- oder ausschalten. Er steht im PDF bei den Zahlungsbedingungen und im XML in BT-20. Beim Festschreiben wird die Wahl eingefroren; bereits festgeschriebene Rechnungen, Gutschriften und Stornos bleiben unverändert.

### Benachrichtigungen (Glocke oben rechts, `/benachrichtigungen`)
Die Glocke im Kopfbereich zeigt die Anzahl ungelesener Benachrichtigungen und eine Kurzliste; „**Alle anzeigen**" führt zur vollständigen Liste. Benachrichtigt wirst du u. a. bei: Rechnung heute fällig, Rechnung überfällig, nächste Mahnstufe erreicht, Angebot läuft bald ab, E-Mail nicht zustellbar, wiederkehrende Rechnung fehlgeschlagen, ungültige E-Rechnung, OSS-Schwelle erreicht, Aktion nach Zahlungseingang ausgelöst oder fehlgeschlagen, Online-Zahlung zu prüfen (Überzahlung, Testzahlung, nicht gebucht). Unter „**Einstellungen → Benachrichtigungen**" schaltest du jeden dieser Typen einzeln an/aus und aktivierst optional einen **täglichen E-Mail-Digest** (eine Sammel-E-Mail statt einzelner Benachrichtigungen). Erzeugt werden Benachrichtigungen von einem dritten Scheduler-Job (`notifications`, nach `recurring`/`dunning`) — läuft automatisch mit dem eingebauten Scheduler/Cron aus Schritt 8, kein separater Aufruf nötig.

### Aktionen nach Zahlungseingang (`Einstellungen → Nach Zahlungseingang`)

Eine Regel führt nach einer erfassten Zahlung feste Aktionen aus. Es gibt keine Skripte; die Aktionsarten sind abschließend. Die Zahlungsbestätigung läuft immer als letzter Schritt: Tag, Benachrichtigung, Webhook und Abo-Fortsetzung hängen nie vom Mailversand ab.

- **Auslöser:** „Vollständig bezahlt" (Rechnung wird PAID) oder „Teilzahlung" (Rechnung bleibt offen, wird PARTIALLY_PAID). Eine Skonto-Folgezahlung löst nichts zusätzlich aus.
- **Quellen:** optional eine Auswahl aus manuell, REST-Schnittstelle, MCP, Bankabgleich, Online (Mollie), Online (Stripe); ohne Auswahl gelten alle. Maßgeblich ist, wie die Zahlung gebucht wurde.
- **Rechnungs-Tag (optional):** die Regel greift nur, wenn die Rechnung dieses Tag trägt.
- **Wartezeit:** 0 bis 1440 Minuten (Voreinstellung 5). Die Aktionen laufen frühestens nach Ablauf, tatsächlich beim nächsten Lauf des eingebauten Schedulers (Job „payment-rules"). Eine Gegenbuchung oder ein Storno innerhalb der Wartezeit überspringt den Lauf („Zahlung gegengebucht", „Rechnung storniert"); ebenso werden noch nicht ausgeführte Läufe einer deaktivierten oder archivierten Regel übersprungen („Regel deaktiviert").
- **Aktionen** (höchstens 5 je Regel, jede Art einmal): Zahlungsbestätigung per E-Mail an den Kunden, Tag an die Rechnung setzen, interne Benachrichtigung (Glocke), Webhook `payment_rule.triggered` senden, pausierte Abos der Rechnung fortsetzen.
- **Zahlungsbestätigung:** nutzt eine E-Mail-Vorlage vom Typ „Zahlungsbestätigung" (`Einstellungen → Vorlagen`), ohne Vorlage einen eingebauten Text (de/en). Zusätzliche Platzhalter: `{{paymentReceived.amount}}`, `{{paymentReceived.date}}`, `{{paymentReceived.openAmount}}`, `{{paymentReceived.method}}`. Kein PDF-Anhang. Die Mail zählt nicht als Rechnungsversand: Versandstatus und Versandprotokoll der Rechnung bleiben unverändert; das Protokoll hängt an der Zahlung (E-Mail-Protokoll, Typ Zahlungsbestätigung). Höchstens 5 Bestätigungen je Kunde und 100 je Firma und Stunde; darüber wird der Lauf verschoben, nicht verworfen.
- **Abos fortsetzen:** pausierte Abos der Rechnung (bei einer Sammelrechnung alle beteiligten Abos) werden wieder aktiv. „Verpasste Zeiträume überspringen" rückt den nächsten Termin hinter die versäumten Zeiträume (nie in die Vergangenheit); „Rückstand nachberechnen" lässt den vorhandenen Termin stehen, sodass der Rückstand abgerechnet wird. Endet das Abo im übersprungenen Zeitraum, bleibt es pausiert und der Schritt gilt als übersprungen. Es werden alle pausierten Abos fortgesetzt, auch ein von Hand pausiertes. Hat das Abo noch eine weitere offene Rechnung, bleibt es pausiert und der Schritt gilt als übersprungen („Weitere offene Rechnung des Abos"). Wird diese weitere Rechnung später storniert statt bezahlt, setzt das kein Abo fort; dann von Hand fortsetzen.
- **Trockenlauf:** „Trockenlauf" wählt eine Rechnung und zeigt, welche Regeln und Schritte greifen würden, inklusive Mailvorschau. Es wird nichts geschrieben und nichts versendet.
- **Protokoll und Wiederholen:** Jeder Lauf mit Status, Schritten und Fehler steht unter „Protokoll (letzte 50 Läufe)" und in der Belegansicht der Rechnung. Fehlgeschlagene Läufe werden automatisch bis zu 5-mal mit wachsendem Abstand wiederholt und lassen sich von Hand wiederholen. Die Fehlertexte sind feste Hinweise; Details stehen im Server-Protokoll.
- **Schutz:** Aktionen buchen nie Zahlungen und lösen keine Regeln aus; je Regel und Zahlung gibt es höchstens einen Lauf, je Regel und Rechnung höchstens 20 Läufe. Bereits ausgeführte Schritte werden durch eine spätere Gegenbuchung oder ein Storno nicht zurückgenommen. Eine Verrechnung mit einer Gutschrift löst keine Regel aus.
- **Ohne Mail-Einstellungen:** Der Mail-Schritt gilt als übersprungen („Keine Mail-Einstellungen hinterlegt“); die übrigen Schritte laufen trotzdem.
- **Mail-Sicherheit:** Eine Bestätigung wird höchstens einmal gesendet. Bleibt das Ergebnis des Versands unklar, steht „Versand unklar – E-Mail-Protokoll prüfen"; es folgt kein automatischer zweiter Versuch.

### Abrechnung nach Verbrauch
Im Abo-Editor wählst du je Position die **Abrechnung**: „fest“ (jeder Lauf nimmt die gespeicherte Menge) oder „nach Verbrauch“. Bei „nach Verbrauch“ entfällt die Menge; stattdessen gibst du einen **Einheitentext** an (z. B. „Aufrufe“; er dient nur der Anzeige im Abo, auf der Rechnung erscheint die gewählte Einheit, in der E-Rechnung als UN/ECE-Code) und den Einzelpreis, auch mit Sub-Cent-Anteil (z. B. `0,002`). Ein Abo braucht weiterhin mindestens eine Position.

- **Verbrauch erfassen:** Auf der Abo-Seite im Abschnitt „Verbrauch“ wählst du die Position, das Datum (Standard: heute, nicht in der Zukunft), die Menge (bis zu 3 Nachkommastellen; `10.000` mit einem Punkt wird als mehrdeutig abgelehnt, schreibe `10000`) und optional eine Notiz. Die Tabelle zeigt Sätze als offen, abgerechnet (mit Link zur Rechnung) oder storniert und je Position die offene Summe. Per REST und MCP geht dasselbe; mit einer `externalId` ist die Erfassung wiederholbar (derselbe Satz wird nicht doppelt angelegt).
- **Verbrauch stornieren:** Offene Sätze lassen sich mit Pflichtgrund stornieren; der Satz bleibt sichtbar. Abgerechnete Sätze sind nicht änderbar. Storniert man die daraus erzeugte Rechnung, bleibt der Verbrauch abgerechnet (Korrektur: neuer Verbrauch oder Gutschrift).
- **Was der Lauf macht:** Der Stichtag gehört vollständig zur endenden Periode: Abos mit Verbrauchsposition werden erst am Berliner Kalendertag **nach** dem Stichtag abgerechnet, damit Verbrauch bis zum Stichtag (auch spät gemeldet) mitzählt; „Jetzt erzeugen“ vor diesem Zeitpunkt wird mit einer Meldung abgelehnt (Abos ohne Verbrauchsposition laufen wie bisher am Stichtag). Das Enddatum lässt sich nicht vor offene Verbräuche legen und ein Abo mit offenen Verbräuchen nicht beenden (erst abrechnen oder stornieren). Der Lauf summiert die offenen Verbräuche je Position bis zum Stichtag, erzeugt die Rechnung (Entwurf oder, bei Auto-Festschreiben, festgeschrieben) und trägt je Verbrauchsposition den Leistungszeitraum ein. Gibt es keinen Verbrauch, entsteht keine Rechnung; „Jetzt erzeugen“ meldet „Keine Verbräuche im Zeitraum“, der nächste Termin rückt weiter, und die Periode zählt nicht für die maximale Zahl der Läufe. Für bereits abgerechnete Zeiträume lässt sich kein Verbrauch mehr erfassen.
- **Zeitplan:** Solange offene Verbräuche existieren, kannst du Rhythmus, Ankertag und nächsten Termin nicht ändern; rechne sie vorher ab oder storniere sie. Verbrauch lässt sich nur für aktive Abos erfassen.

### Abo bearbeiten (`/abos/[id]/bearbeiten`)
Abo-Positionen nutzen dieselbe Positionstabelle wie die Rechnung — neben normalen Positionen mit **Langtext, Artikelnummer und Rabatt** (Prozent oder fester Betrag) gibt es „+ Überschrift“, „+ Textblock“ und „+ Zwischensumme“, die sich per Griff umsortieren lassen. Jeder Lauf übernimmt diese Zeilen unverändert in die neue Rechnung; die Abo-Detailseite zeigt die Blöcke und das Netto.

Über „Bearbeiten" auf der Abo-Detailseite (oder das „⋮"-Menü in der Abo-Liste) änderst du ein bestehendes Abo: Titel, Rhythmus (inkl. **täglich**), Start-/Enddatum, maximale Anzahl Läufe, Zahlungsfrist, Positionen, Auto-Festschreiben/-Versand, E-Mail-Vorlage, Leistungszeitraum-Text. Der Kunde selbst ist nicht änderbar — für einen anderen Kunden legst du ein neues Abo an. Änderst du das Startdatum eines Abos, das noch **keine** Rechnung erzeugt hat, zieht das nächste Erzeugungsdatum automatisch mit; hat das Abo bereits mindestens einen Lauf hinter sich, bleibt der bestehende Erzeugungsplan unangetastet (eine nachträgliche Korrektur soll den laufenden Plan nicht zurückspulen).

---

## 6c. Marke & Steuersätze

### Marke (`Einstellungen → Marke`)
White-Label für deine Instanz — unabhängig vom Briefpapier (Abschnitt 6, das gilt nur für Beleg-PDFs):
- **Name der Instanz** (max. **40** Zeichen) und **Kurzname/Kürzel** (max. **12** Zeichen) ersetzen „OpenInvoice Germany"/„OI" in Seitenleiste, Kopfzeile, Browser-Tab-Titel und Login-Seite. Leer gelassen gilt weiterhin die Produktvorgabe.
- **Favicon**: **quadratisches PNG**, **32–512 px** Kantenlänge, max. **512 KB**. Kein SVG (bewusst — siehe [LIMITATIONEN.md](LIMITATIONEN.md)).
- **App-Logo**: **PNG oder JPEG**, max. **1 MB** — ersetzt das Kürzel-Badge in der Kopfzeile, wird auf 28 px Höhe angezeigt. Mit hinterlegtem Logo steht **nur noch das Bild** dort (kein Name mehr daneben); der Name bleibt als Barrierefreiheits-Text (`alt`) am Bild sowie im Browser-Tab-Titel erhalten.
- Die Herkunftszeile **„powered by OpenInvoice Germany · AGPL-3.0"** mit Link zum Quellcode bleibt in der Fußzeile **immer** sichtbar, egal welcher Name eingetragen ist — sie ist Bedingung der AGPL-3.0-Lizenz und nicht abschaltbar (siehe [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 19).

### Steuersätze (`Einstellungen → Belege`)
Die Liste der für neue Beleg-Positionen wählbaren Umsatzsteuersätze ist **je Organisation** konfigurierbar:
- **1 bis 10 Einträge**, jeweils eine **ganze Zahl zwischen 0 und 100** (Prozent). Vorgabe bei einer neuen Organisation: **19, 7, 0**.
- Ein Satz lässt sich **nicht** entfernen, solange nur noch ein einziger übrig bliebe (mindestens ein Satz ist immer nötig).
- **Bereits ausgestellte Belege behalten ihren Satz**, auch wenn er später aus der Liste entfernt wird (GoBD, § 51) — Editor, Produktformular und Abo-Formular zeigen einen solchen Satz auf einem bestehenden Entwurf/Datensatz zusätzlich als „**19 % (nicht mehr zulässig)**" in der Auswahl an, damit er beim Speichern nicht verloren geht, aber niemand ihn neu auswählen kann.
- **Teilgutschrift** (`/rechnungen/[id]/teilgutschrift`): die Auswahl bietet zusätzlich zur Org-Liste jeden auf der Original-Rechnung tatsächlich verwendeten Satz als „**geerbt**" an, auch wenn er nicht mehr in der Org-Liste steht — eine Teilgutschrift muss immer zum selben Satz möglich sein wie die Original-Position.
- Der Versuch, eine **neue** Position (oder einen neu gewählten Satz auf einem bestehenden Entwurf) mit einem nicht freigegebenen Satz zu speichern, scheitert mit der Fehlermeldung „**Steuersatz X % ist für diese Organisation nicht freigegeben (Einstellungen → Belege).**" — sowohl im Editor als auch bei Produkten, Abo-Vorlagen, Teilgutschriften und über API/MCP.

---

## 6d. Anfrageprotokoll (`Einstellungen → API → Anfrageprotokoll`)

Wer die REST-API (`/api/v1`, siehe [docs/API.md](API.md)) nutzt, kann sich fehlgeschlagene und langsame Aufrufe zur Fehlersuche protokollieren lassen:

- **Einschalten**: „Anfragen protokollieren" ist **standardmäßig AUS** — ohne diesen Haken bleibt die Tabelle leer, es entsteht keine einzige Zeile. Zusätzlich „Bodies mitschreiben" schaltet Request- **und** Response-Bodies dazu (Response-Body nur bei Fehlern, Status ≥ 400).
- **Fehler nachvollziehen**: die Tabelle zeigt Zeit, Methode, Pfad, Status (farbig ab 400/500), Dauer und den verwendeten Schlüssel, neueste zuerst; der Filter „nur Fehler (≥ 400)" sowie Filter nach Schlüssel, Pfad und Zeitraum grenzen ein.
- **Detail öffnen**: ein Klick auf eine Zeile öffnet die Detail-Schublade mit Request-ID (identisch mit dem `X-Request-Id`-Header der jeweiligen Antwort — nützlich beim Abgleich mit eigenen Client-Logs), vollständigem Pfad, IP, User-Agent und — falls „Bodies mitschreiben" aktiv war — Request-/Response-Body.
- **Protokoll leeren**: löscht sofort das gesamte Protokoll der eigenen Organisation (Bestätigungsdialog, nicht rückgängig zu machen). Ohne aktiven Scheduler-Lauf (Abschnitt „Schritt 8") wächst die Tabelle sonst bis zum nächsten automatischen Aufräumen weiter — Aufbewahrung (Tage) und maximale Zeilenzahl je Organisation sind ebenfalls hier einstellbar.

**Hinweis zum Kopfdaten-Modus:** Auch ohne „Bodies mitschreiben" speichert „Anfragen protokollieren" bereits Pfad **inklusive Query-String**, IP-Adresse und User-Agent jeder Anfrage — Parameter mit verdächtigem Namen (`token`, `secret`, `password`, `apiKey`, `iban`, `bic`, `email`, …) werden dabei vor dem Speichern automatisch geschwärzt.

**Warnung:** „Bodies mitschreiben" schreibt die tatsächlich gesendeten/empfangenen JSON-Inhalte (bis 2 KB, gekürzt) in die Protokolltabelle — das können Kundendaten sein (Namen, Adressen, Beträge). Bekannt gefährliche Feldnamen (`token`, `secret`, `password`, `apiKey`, `iban`, `bic`, `authorization`, …) werden vor dem Speichern automatisch geschwärzt, ein genereller Datenschutzfilter ist das aber nicht — nur einschalten, wenn die konkrete Fehlersuche das rechtfertigt, und danach wieder ausschalten oder das Protokoll leeren.

---

## 6e. Belegvorlagen & Tags

### Belegvorlagen (`/vorlagen`)

Eine Vorlage speichert Positionen und Kopf-Metadaten eines bereits **gespeicherten** Belegs (Rechnung, Angebot/AB/Proforma oder Lieferschein) für den späteren Neuaufbau — **ohne** Belegnummer, Datum, Snapshots, Zahlungen oder interne Notizen (§48): eine Vorlage ist ein Schnappschuss und ändert sich nicht mehr, wenn der Ursprungsbeleg später geändert wird.

- **Anlegen**: auf einer Beleg-Detailseite oder in einer Liste über „Mehr → Als Vorlage speichern" — Name vergeben, fertig.
- **Beleg daraus erzeugen**: auf `/vorlagen` bei der gewünschten Vorlage auf „Beleg erzeugen" — legt einen neuen Entwurf mit denselben Positionen an und öffnet ihn. Bei Rechnungen/Angeboten landest du im Editor; ein Lieferschein kennt keinen eigenen Editor und landet direkt auf seiner Detailseite (siehe [LIMITATIONEN.md](LIMITATIONEN.md)). Legt die Vorlage selbst keinen Kunden fest, lässt sich daraus kein Beleg erzeugen (siehe [LIMITATIONEN.md](LIMITATIONEN.md)) — ein Kunde muss dann vorher per `PATCH /api/v1/DocumentTemplate/{id}` (Feld `customerId`) an der Vorlage hinterlegt werden (ein MCP-Werkzeug dafür gibt es bislang nicht).
- **Umbenennen/Löschen**: direkt auf `/vorlagen` — das Löschen einer Vorlage rührt keinen mit ihr bereits erzeugten Beleg an.

### Tags (`Einstellungen → Tags`)

Tags sind ein freies Ordnungsmerkmal über Rechnungen, Angeboten/AB/Proforma und Lieferscheinen — **rein intern**: ein Tag ist reine Metadatenverwaltung, kein Bestandteil des Belegs selbst, und erscheint **nie** beim Kunden (nicht im PDF, nicht in der XRechnung/im ZUGFeRD-XML, nicht im Mailtext, nicht im öffentlichen Angebots-Annahmelink). Ein Tag lässt sich deshalb auch an einer bereits **festgeschriebenen** Rechnung setzen oder entfernen, ohne die GoBD-Unveränderbarkeit zu berühren.

- **Anlegen**: `Einstellungen → Tags` — Name (je Organisation eindeutig) und eine von acht Farben.
- **An einem Beleg setzen**: in der Detailkarte des Belegs oder direkt in der Listenzeile über die Tag-Chips.
- **Filtern**: in den Listen (`/rechnungen`, `/dokumente`, `/lieferscheine`) über den Tag-Filter der Filterleiste.
- **Löschen**: `Einstellungen → Tags` — entfernt automatisch alle Zuordnungen dieses Tags, rührt aber keinen Beleg an.

---

## 6f. Kundenportal

Mit dem Kundenportal können Kunden ihre Belege selbst abrufen, ohne Konto und ohne Anhänge in jeder Mail. Das Portal ist **standardmäßig aus**.

### Einschalten (`Einstellungen → Kundenportal`)

- **Kundenportal einschalten:** Solange es ausgeschaltet ist, lassen sich keine Links anlegen, und bestehende Links zeigen nichts an.
- **Gültigkeit neuer Links:** 1 bis 730 Tage, Standard 365.
- **Versendete Mahnungen anzeigen** und **E-Rechnung (XML) zum Download anbieten:** je ein Schalter (Standard an).
- **Mail mit dem Portal-Link:** eigener Betreff und Text (leer = eingebauter Text in der Sprache des Kunden). Platzhalter u. a. `{{portal.url}}`, `{{portal.validUntil}}`, `{{customer.name}}`, `{{company.name}}`.
- Links entstehen aus der Umgebungsvariable `APP_BASE_URL`; ohne sie meldet die Oberfläche, dass keine Basisadresse gesetzt ist.

### Link erzeugen, senden, widerrufen (`Kunden → <Kunde>`, Karte „Kundenportal")

- **Link erzeugen:** legt einen neuen Link an. Ein bereits aktiver Link wird dabei widerrufen (Rotation). Der Link wird nur auf Knopfdruck angezeigt und kopiert; er steht nie in Listen oder Protokollen der Anwendung. Zugriffsprotokolle von Reverse-Proxy und CDN enthalten den Pfad samt Token; Hinweis in `docs/BETRIEB-VORLAGE.md`.
- **Per Mail senden:** schickt den aktiven Link an die Rechnungs-E-Mail des Kunden oder an eine angegebene Adresse (höchstens 3 Mails je Kunde und Stunde). Im Versandprotokoll steht statt des Links nur „[Portal-Link]".
- **Widerrufen:** der Link liefert sofort die Fehlerseite „nicht gefunden", ebenso nach Ablauf. Wird ein Kunde archiviert, wird sein Link automatisch widerrufen.
- **Wer den Link kennt, sieht alle Belege dieses Kunden.** Gib ihn nur an den Kunden weiter; bei Verdacht auf Weitergabe neuen Link erzeugen.

### Was der Kunde sieht

Eine Seite in der Sprache des Kunden mit Firmenname, offenen Posten je Währung (davon überfällig) und einer Tabelle seiner **festgeschriebenen** Rechnungen, Gutschriften/Stornos und **versendeten** Mahnungen, jeweils mit Status und Download als PDF und (wenn eingeschaltet) E-Rechnung (XML). Die Dateien kommen unverändert aus dem Belegarchiv, es ist derselbe Stand wie bei der ersten Ausgabe. Entwürfe, interne Notizen, Tags, Abos und andere Kunden erscheinen nie. Das Portal ist nur eine Ansicht: der Kunde kann nichts eingeben. Ist die Online-Zahlung eingeschaltet (6h), erscheint bei offenen Rechnungen zusätzlich ein Knopf „Jetzt bezahlen".

### Abrufprotokoll

Auf der Kundenkarte stehen die letzten Abrufe. Protokolliert werden das Öffnen der Seite (höchstens einmal je Link und Berliner Kalendertag) und jeder Download, **ohne IP-Adresse und ohne Browserkennung**. Die Einträge sind unveränderlich und werden nach 24 Monaten gelöscht. Auch REST (`GET /api/v1/Contact/{id}/portal-events`) und MCP liefern sie.

---

## 6g. Bankabgleich

Unter **„Bankabgleich"** (Hauptmenü) liest die App Kontoauszüge deiner Bank und schlägt vor, welche Rechnung ein Zahlungseingang bezahlt. **Gebucht wird nie automatisch**: jede Zuordnung bestätigst du selbst, einzeln oder als Sammelbestätigung eindeutiger Vorschläge.

### Kontoauszug exportieren und hochladen

- Exportiere im Onlinebanking den Kontoauszug als **CAMT.053** (Tagesauszug) oder **CAMT.054** (Einzelbuchungsmitteilung), Format **XML**, Zeichensatz **UTF-8**. Unterstützt sind die Versionen 02 bis 13.
- **Kein ZIP:** Liefert die Bank ein Archiv, entpacke es vorher und lade die XML-Datei hoch. Die Datei darf höchstens 10 MB groß sein. MT940, CSV und camt.052 werden nicht gelesen.
- Auf der Seite wählst du die Datei aus. Es erscheint zuerst eine **Vorschau** (Format, Konto, neue Umsätze, Duplikate, verworfene Einträge nach Grund, Warnungen). Erst **„Importieren"** speichert die Umsätze. Dieselbe Datei wird nur einmal importiert; bereits bekannte Umsätze aus einer anderen, überlappenden Datei werden als Duplikate erkannt und nicht doppelt angelegt.
- Importiert werden nur **gebuchte Gutschriften** (Zahlungseingänge) und **Rückbuchungen**. Belastungen (Ausgänge), Rückgaben eigener Überweisungen mit Rückgabeinfo, nicht gebuchte Einträge und Beträge von 0 werden verworfen und nur gezählt.
- Warnungen weisen z. B. auf ein unbekanntes Konto (IBAN weder bei der Firma noch bei einer Zahlungsart hinterlegt), mehrere Konten in einer Datei, Fremdwährungen oder enthaltene Rückbuchungen hin.

### Vorschläge prüfen und bestätigen

Jeder offene Umsatz zeigt Vorschläge mit Begründung und Sicherheit. **Sicher** ist ein Vorschlag nur bei genau einer vollständig genannten Rechnungsnummer mit passendem Betrag (offener Rest oder Skontobetrag); alles andere ist **möglich**. Die App wertet Rechnungsnummer im Verwendungszweck, passenden Betrag, ein gemerktes Gegenkonto des Kunden (nur als Hash), die Mandats-IBAN und die Ähnlichkeit des Namens aus. Du kannst:

- **Zuordnung bestätigen:** bucht die Zahlung auf die Rechnung (Herkunft „Bank", Zahlungsreferenz = Verwendungszweck, gekürzt auf 140 Zeichen).
- **Aufteilen:** ein Umsatz auf mehrere Rechnungen verteilen, auch mit Teilbeträgen. Die Summe darf den Umsatz nicht überschreiten.
- **Skonto:** ein Vorschlag mit Skonto-Abzug wird **nur einzeln** bestätigt, nie in der Sammelbestätigung.
- **Überzahlung:** Ein Überschuss wird **nie als Zahlung gebucht**. Der Umsatz bleibt teilweise zugeordnet („Teilweise"); den Rest klärst du selbst (z. B. Rückzahlung oder Zuordnung zu einer anderen Rechnung) oder markierst den Umsatz mit Begründung als **ignoriert**.
- **Eindeutige Zuordnungen übernehmen:** bestätigt in einem Schritt alle Umsätze mit genau einem sicheren Vorschlag (höchstens 200 je Aufruf; bei mehr weist die App darauf hin) und zeigt einen Ergebnisbericht mit den übersprungenen Umsätzen.
- **Ignorieren / wieder öffnen:** ein Umsatz ohne Rechnungsbezug (z. B. private Überweisung) wird mit Grund ignoriert und lässt sich wieder öffnen.

### Rückbuchungen und Rücklastschriften

- Ein **Zahlungseingang bleibt der Rechnung zugeordnet**, auch wenn die Bank später zurückbucht. Kommt eine **Rücklastschrift** (Rückgabe einer Lastschrift, Umsatz als Belastung), erscheint sie im Reiter „Rückgaben" als „Rückbuchung – prüfen". Du wählst die betroffene Zahlung; die App **bucht sie per Gegenbuchung gegen** und hebt damit den Zahlungseingang auf. Die Rechnung ist danach wieder offen bzw. teilweise offen.
- Die Gegenbuchung trägt als Datum den **Buchungstag der Bank** der Rückbuchung, nicht den Tag der Bestätigung; Auswertungen zählen sie damit im Monat der Bankbuchung.
- **Falsch bestätigt?** Eine bestätigte Rücklastschrift lässt sich nicht zurücknehmen: Die Gegenbuchung wird nicht erneut gegengebucht, der Rückbuchungs-Umsatz bleibt erledigt. Korrigiere, indem du die Zahlung an der Rechnung erneut erfasst (Zahlungsdialog). Eine bereits voll gegengebuchte Zahlung lässt sich in der Bankabgleich-Ansicht nicht mehr „zurücknehmen“; der Knopf wird dort nicht mehr angeboten.
- **Rückgabegebühren** der Bank (Umsatz größer als die gegengebuchte Zahlung) werden **nicht gebucht**; die App meldet sie nur.
- **Rückbuchungen zu eigenen Zahlungen** (Gutschrift mit Rückbuchungskennzeichen, also Rückgabe einer eigenen Überweisung) lassen sich **nur als erledigt markieren**, nicht gegen Kundenzahlungen buchen.

### Zurücknehmen und Stornieren

- **Zuordnung zurücknehmen:** nimmt die Zuordnung per **Gegenbuchung** der Zahlung zurück (mit Grund). Die Gegenbuchung trägt das Datum der ursprünglichen Zahlung, damit eine Fehlzuordnung im selben Zeitraum neutralisiert wird. Nichts wird gelöscht; Zuordnung und Gegenbuchung bleiben nachvollziehbar.
- **Zahlung manuell stornieren:** Stornierst du eine aus dem Bankabgleich stammende Zahlung an der Rechnung, führt die App den **Zuordnungsbetrag des Bankumsatzes mit** (der Umsatz wird wieder teilweise bzw. ganz offen).

### Was gespeichert wird

Je Umsatz speichert die App Buchungs- und Wertstellungsdatum, Betrag, Währung, **Name und IBAN des Gegenkontos**, den **Verwendungszweck** (bis 500 Zeichen), Referenzen der Bank und den Status. Die Zahlung an der Rechnung trägt den Verwendungszweck als Zahlungsreferenz. IBANs erscheinen in Oberfläche, REST und MCP nur maskiert. Die gelernte Zuordnung „Gegenkonto → Kunde" speichert nur einen Hash der IBAN und benötigt `AUTH_SECRET`. Die Datei selbst wird **nicht** aufbewahrt, auch keine Belastungen und kein Kontostand. Kontoauszüge bleiben Buchungsbelege deiner Buchhaltung; bewahre sie dort wie bisher auf (siehe [COMPLIANCE.md](../COMPLIANCE.md) § 22).

**Ignorierte und erledigte Umsätze:** Auch Umsätze ohne Rechnungsbezug (ignoriert oder als erledigt markiert) behalten Name und IBAN des Gegenkontos sowie den Verwendungszweck. Sie gehören als Teil der Kontoauszugsdaten zu den aufbewahrungspflichtigen Buchungsunterlagen (§ 147 AO). Die App bietet für festgeschriebene Bankdaten vor Fristablauf bewusst keine Löschfunktion; nach Fristablauf entfernst du sie nur mit direktem Datenbankzugriff.

Auch per REST (`/api/v1/BankStatement`, `/api/v1/BankTransaction`, siehe [API.md](API.md)) und MCP (siehe [MCP.md](MCP.md)) nutzbar.

---

## 6h. Online-Zahlung (Mollie und Stripe)

Rechnungen können einen **Bezahllink** erhalten: Der Kunde öffnet ihn, sieht Rechnungsnummer und offenen Betrag und zahlt beim Zahlungsanbieter **Mollie** oder **Stripe**. Die Anbindung ist **standardmäßig aus**. Weitere Anbieter gibt es nicht.

### Einrichten (`Einstellungen → Online-Zahlung`)

1. **Voraussetzung:** Die Umgebungsvariable `APP_BASE_URL` ist gesetzt und von außen erreichbar (Bezahllink und Webhook-Adresse entstehen daraus; ohne sie meldet die Oberfläche, dass keine Basisadresse gesetzt ist). Außerdem muss `AUTH_SECRET` gesetzt sein, weil der Schlüssel verschlüsselt gespeichert wird.
2. **API-Schlüssel eintragen:** Den Schlüssel gibt es bei Mollie (`test_…` für den Testmodus, `live_…` für den Livemodus). Er wird verschlüsselt gespeichert und nie wieder angezeigt, nur „hinterlegt" und die letzten 4 Zeichen. Der Modus (Test oder Live) ergibt sich aus dem Schlüssel. **Jeder Schlüsselwechsel schaltet die Anbindung aus.** Schlüssel und Einschalter gibt es nur in der Oberfläche, nicht über REST oder MCP.
3. **Verbindung prüfen:** baut eine echte Verbindung zu Mollie auf und liest nur die verfügbaren Zahlarten; es wird nichts gebucht. Zwischen zwei Tests liegen mindestens 10 Sekunden.
4. **Einschalten:** erst nach einem erfolgreichen Verbindungstest möglich.
5. **Zahlarten und Währungen:** optional Kennungen der erlaubten Zahlarten (leer = alle aktiven Zahlarten bei Mollie) und die Währungen, für die Links entstehen (Standard nur EUR).
6. **Standardanbieter und Anzeige:** Standardanbieter „Mollie" oder „Kein"; Schalter, ob der Link im Rechnungs-PDF, in E-Mails (über den Platzhalter) und im Kundenportal erscheint (je Standard an).

Die Einrichtung gilt je Anbieter; die Oberfläche zeigt für Mollie und Stripe je einen eigenen Abschnitt. Die Beschreibung in diesem Abschnitt nennt Mollie; Abweichungen von Stripe stehen unter „Stripe einrichten“.

Mollie ruft die Anwendung über eine Webhook-Adresse unter `/api/public/payments/mollie/<geheime Kennung>` auf. Sie wird bei jeder Zahlung automatisch mitgegeben und muss nicht bei Mollie eingetragen werden; sie muss aus dem Internet erreichbar sein.

### Stripe einrichten

Stripe wird im Abschnitt „Stripe“ derselben Seite eingerichtet. Die Anwendung nutzt Stripe Checkout (gehostete Bezahlseite von Stripe) mit Betrag und Währung genau wie auf der Rechnung (Preise in Kundenwährung sind aus); die Sitzung läuft nach 60 Minuten ab.

1. **Voraussetzung:** wie oben `APP_BASE_URL` und `AUTH_SECRET`. **`APP_BASE_URL` muss vor dem Festschreiben gesetzt sein**, sonst entsteht beim Festschreiben kein Link auf dem Beleg.
2. **API-Schlüssel eintragen:** Empfohlen ist ein eingeschränkter Schlüssel (`rk_live_…`, bzw. `rk_test_…`) mit den Rechten „Checkout Sessions schreiben“ sowie „PaymentIntents, Charges und Disputes lesen“. Ein vollständiger Schlüssel (`sk_live_…`/`sk_test_…`) wird ebenfalls akzeptiert. Der Schlüssel wird verschlüsselt gespeichert und nie wieder angezeigt; der Modus ergibt sich aus dem Schlüssel.
3. **Ereignisziel im Stripe-Dashboard von Hand anlegen:** Die Anwendung legt es nicht per Schnittstelle an. Unter „Entwickler → Ereignisziele“ ein Ziel mit Format **Snapshot** (nicht „Thin“) anlegen, die in der Oberfläche angezeigte Adresse (`/api/public/payments/stripe/<geheime Kennung>`) eintragen und die dort aufgeführten **acht Ereignisse** auswählen: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`.
4. **Signaturschlüssel eintragen:** Den Signaturschlüssel des Ereignisziels (`whsec_…`) trägst du in der Oberfläche ein; er wird verschlüsselt gespeichert und nie wieder angezeigt. Jeder Schlüsselwechsel (API-Schlüssel oder Signaturschlüssel) und das Entfernen des Signaturschlüssels schalten die Anbindung aus.
5. **Verbindung prüfen:** liest höchstens eine Checkout-Sitzung; es wird nichts gebucht (mindestens 10 Sekunden zwischen zwei Tests).
6. **Einschalten:** erst nach erfolgreichem Verbindungstest **und** hinterlegtem Signaturschlüssel möglich.

Danach gilt wie bei Mollie: Voreinstellung „Stripe“ in den Einstellungen, an der Zahlungsart oder am Kunden wählen. Die Benachrichtigung wird zuerst über die Signatur (Rohdaten, Toleranz 5 Minuten, daher muss die Serveruhr per NTP stimmen) geprüft, trotzdem bucht die Anwendung nie aus ihrem Inhalt, sondern lädt Sitzung, Zahlung, Charge und Disputes selbst bei Stripe nach.

Unterschiede zu Mollie:

- **Zahlungsdatum:** Stripe liefert kein Zahlungsdatum an der Sitzung. Als Zahlungsdatum gilt der **Zeitpunkt der Feststellung** (Benachrichtigung oder Abgleich, meist Sekunden nach der Zahlung; bei SEPA-Lastschrift der Erfolgstag).
- **Dispute (Zahlungsstreit):** Sobald Stripe den Betrag eines Disputes abzieht (meist bei Eröffnung), wird automatisch gegengebucht. Wird der Dispute gewonnen und der Betrag zurückgebucht, meldet die Anwendung das nur; die erneute Buchung erfolgt von Hand. Reine Anfragen ohne Abzug buchen nichts. Gebühren von Stripe werden nicht gebucht.
- **Testkonto:** Mit `rk_test_`/`sk_test_` bucht die Anwendung nie (wie bei Mollie). Bezahllinks, die vor dem Update auf diese Version angelegt wurden (Bestand, gilt für alle Anbieter), gelten als im Livebetrieb ausgegeben und sind im Testkonto nicht verfügbar; die Bezahlseite zeigt „derzeit nicht verfügbar“.
- **Manuelle Gegenbuchung:** Hast du eine Online-Zahlung von Hand gegengebucht und erstattet Stripe später, wird die Erstattung auf diese Gegenbuchung angerechnet; es entsteht keine zweite Gegenbuchung.
- **Netz sperren:** `PAYMENT_NETWORK=0` sperrt auch Aufrufe zu Stripe.
- **Datenschutz:** siehe „Datenschutz und Betrieb“; die Datenschutzrolle von Stripe klärst du vor dem Livebetrieb.

### Wann bekommt eine Rechnung einen Link?

Beim **Festschreiben** wird der Anbieter bestimmt. Vorrang: **Zahlungsart** (Feld „Online-Zahlung (Bezahllink)"), dann **Kunde** (gleiches Feld), dann die **Voreinstellung** der Firma. „Kein" an einer Stelle beendet die Kette ausdrücklich; leer heißt „keine Vorgabe". Kein Link entsteht bei Gutschriften, ohne offenen Betrag, bei SEPA-Lastschrift mit Mandat, bei der Zahlungsart „Bereits bezahlt", bei ausgeschaltetem Zugang oder bei einer Währung, die nicht freigegeben ist. Für **Bestandsrechnungen** gibt es keinen Massen-Nachtrag: Auf der Belegseite (Abschnitt „Online-Zahlung") legst du den Link einzeln an, deaktivierst oder reaktivierst ihn und rufst den Status ab. Eine stornierte Rechnung bekommt nie einen Link; ein vorhandener wird beim Storno deaktiviert. Ein beim Festschreiben bereits ausgegebener Link auf dem PDF bleibt im Archiv unverändert; wird er später deaktiviert, zeigt die Bezahlseite „nicht verfügbar".

### Der Weg des Kunden

Der Link `/zahlen/<Token>` zeigt Firmenname, Rechnungsnummer, Rechnungsdatum und den offenen Betrag mit dem Knopf „Jetzt bezahlen". **Erst der Klick** legt den Bezahlvorgang bei Mollie an (Betrag = offener Rest, Bezeichnung „Rechnung <Nummer>") und leitet weiter; ein Seitenaufruf ruft Mollie nie auf. Ein noch ausreichend lange gültiger Vorgang mit gleichem Betrag wird wiederverwendet. Nach der Zahlung kehrt der Kunde zur Seite zurück, die den Status sofort abfragt. Ist die Rechnung bezahlt oder storniert, nennt die Seite das; sonst steht dort „derzeit nicht verfügbar" mit dem Hinweis auf die Zahlungsangaben der Rechnung. Der Link enthält ein 256-Bit-Token; wer ihn kennt, kann diese eine Rechnung bezahlen, sonst nichts.

### Wann wird gebucht?

**Nie aufgrund der Benachrichtigung von Mollie.** Deren Aufruf liefert nur eine Kennung; die Anwendung lädt den Zustand selbst bei Mollie nach und bucht erst, wenn Mollie die Zahlung als bezahlt meldet. Gebucht wird über die reguläre Zahlungserfassung (Zahlungsart „Online", Referenz = Mollie-Zahlungsnummer), also mit Regeln nach Zahlungseingang, Webhook `payment.recorded` (`provider` `MOLLIE`) und Eintrag in der Hash-Kette. Zusätzlich gleicht der Scheduler offene Vorgänge ab, falls eine Benachrichtigung ausfällt: alle 15 Minuten, ab 3 Tagen täglich, bis 14 Tage nach Anlage; bezahlte Vorgänge werden bis 180 Tage nach Anlage mit abnehmender Häufigkeit nachgeprüft (Erstattung und Rückbuchung).

- **Testmodus bucht nie.** Zahlungen mit einem `test_`-Schlüssel erzeugen nur eine Benachrichtigung „Testzahlung eingegangen" und einen Protokolleintrag. Links im Testmodus erscheinen nie auf PDF, E-Rechnung, in Mails oder im Portal; auf der Belegseite gibt es einen internen „Testlink".
- **Kein Skonto online.** Die Online-Zahlung bucht immer den vollen offenen Rest ohne Skonto.
- **Überzahlung:** Gebucht wird höchstens der offene Rest; den Mehrbetrag meldet eine Benachrichtigung „Online-Zahlung höher als offener Betrag". Die Erstattung beim Anbieter machst du von Hand.
- **Rechnung inzwischen storniert oder nichts mehr offen:** Es wird nichts gebucht; eine Benachrichtigung meldet die Zahlung zur Erstattung.
- **Erstattung und Rückbuchung:** Meldet Mollie eine Erstattung oder Rückbuchung, bucht die Anwendung eine Gegenbuchung der Zahlung (kumuliert, bei mehreren Teilbeträgen nur die Differenz) und öffnet die Rechnung wieder; ein nach vollständiger Zahlung automatisch deaktivierter Link wird dabei wieder aktiv. Existiert zur Rechnung bereits eine **Gutschrift oder Teilgutschrift**, wird eine Erstattung bei Mollie **nicht** gegengebucht (der Betrag ist durch die Gutschrift erledigt); die Anwendung meldet sie einmal mit „Erstattung beim Zahlungsanbieter – bitte manuell zuordnen“, Rückbuchungen werden weiterhin automatisch gegengebucht. Wird eine Erstattung bei Mollie später **verringert oder aufgehoben**, bucht die Anwendung nichts neu, sondern meldet es zur Prüfung; die Buchung korrigierst du von Hand.
- **Gebühren** von Mollie werden nicht gebucht.
- Stimmen Betrag, Währung oder Modus der Zahlung nicht zum Vorgang, wird nichts gebucht und eine Prüfmeldung angelegt.

### Wo erscheint der Link?

- **PDF:** Zeile „Online bezahlen: <Adresse>" im Zahlungsblock, dazu ein QR-Code (20 mm), **nur wenn kein GiroCode** gedruckt wird. Nur bei Livekonto, offener Rechnung und gesetzter `APP_BASE_URL`; er wird beim Festschreiben festgelegt.
- **E-Rechnung:** derselbe Satz steht am Ende der Zahlungsbedingungen (BT-20) in XRechnung und ZUGFeRD; Zahlungscode und Bankdaten bleiben unverändert. Die neue Systemzahlungsart „Online-Zahlung" (Code 68) kannst du an einer Rechnung wählen; dann steht kein Bankkonto in der E-Rechnung.
- **E-Mail:** Platzhalter `{{invoice.paymentLink}}` in deinen Vorlagen (z. B. unter `Einstellungen → Textvorlagen`). Die Standardvorlagen bleiben unverändert; ergänze den Platzhalter in deiner Vorlage selbst. Er ist leer, wenn kein aktiver Livelink, die Mail-Anzeige aus, nichts offen oder die Rechnung storniert ist. Im Versandprotokoll und in der Hash-Kette steht statt des Links „[Zahlungslink]".
- **Kundenportal:** Knopf „Jetzt bezahlen" bei offenen Rechnungen mit aktivem Link.
- **Belegseite:** Abschnitt „Online-Zahlung" mit Linkstatus, Adresse (zum Kopieren und Öffnen), den letzten Bezahlvorgängen und „Status abrufen". Ein Vorgang mit „Anlage unklar" bedeutet: Beim Anbieter prüfen, ob eine Zahlung entstanden ist, und ggf. von Hand buchen.
- **Regeln nach Zahlungseingang:** Quellen „Online (Mollie)“ und „Online (Stripe)“ lassen sich als Filter wählen (6b).

### Datenschutz und Betrieb

An Mollie gehen nur Betrag, Währung, die Bezeichnung „Rechnung <Nummer>", die Rückkehr- und die Webhook-Adresse, nie Positionen, Kundenname oder interne Notizen. Welche Rolle Mollie datenschutzrechtlich hat (Auftragsverarbeitung oder eigene Verantwortlichkeit), richtet sich nach den Bedingungen von Mollie; kläre das **vor dem Einschalten im Livemodus** (siehe COMPLIANCE.md). An Stripe gehen Betrag, Währung, Rechnungsnummer und die Rückkehradresse (Erfolg/Abbruch); Name, Anschrift und Zahlungsdaten erhebt Stripe beim Kunden selbst, nie Positionen oder interne Notizen. Für den Reverse-Proxy: Pfade `/zahlen/` und `/api/public/payments/` ohne Zugriffsprotokoll führen, da das Token im Pfad steht (siehe `docs/BETRIEB-VORLAGE.md`). Mit `PAYMENT_NETWORK=0` sperrst du jeden Netzaufruf zu Mollie und Stripe (Notbremse, auch für Tests).

---

## 6i. DATEV-Export (`Einstellungen → DATEV`)

Der Export erzeugt eine **Datei für deinen Steuerberater** (Buchungsstapel im DATEV-Format). Die Anwendung ist keine Buchhaltung, meldet nichts an DATEV und ruft nichts im Netz ab. Die Einrichtung stimmst du mit dem Steuerberater ab.

### Einrichten
1. **Einstellungen:** Beraternummer, Mandantennummer, Sachkontenlänge, Wirtschaftsjahr, Debitoren (je Kunde ein Personenkonto oder ein Sammeldebitor), Bank- und Kassenkonto, optional Diktatkürzel. „Zahlungen exportieren“ ist **standardmäßig aus**: Bucht die Kanzlei die Zahlungen selbst aus dem Kontoauszug, würden Geldbuchungen doppelt entstehen. Beim Einschalten merkt sich die Anwendung den Zeitpunkt: Der erstmalige Export eines Monats enthält alle Zahlungen; Nachträge und Wiederholungen von Monaten, die vor dem Einschalten exportiert wurden, enthalten keine Zahlungen (Hinweis im Protokoll). Das Kassenkonto aus den Einstellungen nimmt Barzahlungen auf; Zahlungsarten ohne Kontenzuordnung (z. B. Karte) werden als Handbuchung gemeldet, nie auf die Bank gebucht.
2. **Vorlage:** SKR03 oder SKR04 übernehmen. Die Vorlage ist **nur ein Vorschlag** und keine Bestätigung. Für Differenzbesteuerung gibt es bewusst kein Konto; das nennt der Steuerberater. Das Skontokonto muss im DATEV-Stamm der Kanzlei angelegt sein.
3. **Bestätigen:** Die Kontenzuordnung ausdrucken, vom Steuerberater prüfen lassen, dann „Ich habe das mit dem Steuerberater geklärt.“ ankreuzen, „Abgestimmt mit / am“ ausfüllen und bestätigen. Das geht **nur in der Oberfläche** (nicht per REST oder MCP). Jede Änderung an Einstellungen oder Zuordnung macht die Bestätigung hinfällig; bis dahin ist der Export gesperrt.

### Exportieren
Unter „Export“ Von/Bis (Monat) wählen — nur abgeschlossene Monate, höchstens zwölf je Export. „Vorschau“ zeigt Zähler, Hinweise und Handbuchungen und schreibt nichts. „ZIP herunterladen“ erzeugt den Export und legt die Datei unveränderlich im Archiv ab. Die ZIP enthält je Monat einen Buchungsstapel, optional die Debitorenstammdaten und das Protokoll. Das Festschreibekennzeichen ist einstellbar, Standard 0 (nicht festschreiben); das erledigt in der Regel die Kanzlei nach Prüfung.

### Handbuchungen
Was die Anwendung nicht sicher buchen kann, steht mit Grund als Handbuchung im Protokoll: Differenzbesteuerung ohne Konto, Zahlung in Fremdwährung, Skonto ohne Basiszahlung, Storno einer Schlussrechnung, Korrekturrechnung, ungültige USt-IdNr. des Käufers, negative Zahlung (Erstattung) und eine Gegenbuchung ohne Originalzahlung. Diese Fälle bucht die Kanzlei von Hand.

### Nachtrag und Wiederholung
Wird nach einem Export ein Beleg oder eine Zahlung in einem bereits exportierten Monat nachgetragen, erscheint sie unter „Nachträge“ und wird mit Modus „Nachtrag“ in einer eigenen ZIP exportiert. Ob die Kanzlei den Nachtrag noch einarbeiten kann, klärst du mit ihr. Einen bereits exportierten Monat erneut zu exportieren geht nur mit ausdrücklicher Freigabe („Wiederholung“).

### Gut zu wissen
- Felder für Leistungsdatum und Fremdwährung bleiben leer, der Umsatz steht in EUR; bei Automatikkonten ist 1 Cent Abweichung je Beleg möglich.
- Zeichen außerhalb von Windows-1252 werden ersetzt (Akzentbuchstaben transliteriert, sonst `?`); das Protokoll nennt die betroffenen Zeichen. Texte mit `=`, `+`, `-` oder `@` am Anfang erhalten einen Apostroph (Schutz vor Formeln in Tabellenkalkulationen).
- Interne Notizen und Kontaktdaten (Mail, Telefon, IBAN) gehören nicht in den Export.
- **Abnahme:** Prüfe die erste ZIP einmal mit dem DATEV-Prüfprogramm (Windows) beim Steuerberater, bevor du den Export regelmäßig nutzt.

Auch per REST (`/api/v1/DatevExport`, Scope `admin`, siehe [API.md](API.md)) und MCP ([MCP.md](MCP.md)).

## 7. Per Sprache mit einem KI-Assistenten (MCP)

Statt Formulare auszufüllen, kannst du OpenInvoice auch **per Sprache** über einen mitgelieferten **MCP-Server** bedienen — mit jedem MCP-fähigen KI-Assistenten. Einrichtung, Datenschutz-Hinweise (DSGVO/Art. 28) und die vollständige Tool-Liste stehen in **[docs/MCP.md](MCP.md)**; lies das dort zuerst, bevor du echte Kundendaten per Cloud-LLM verarbeiten lässt.

Alle wichtigen Funktionen aus dieser Anleitung sind auch als MCP-Tool erreichbar — der Assistent ruft dieselben, gleich validierten Funktionen auf wie UI und API (keine Bypass-Pfade). Beispielsätze:

> **„Erstelle für Müller GmbH ein Angebot über 10 Stunden Beratung zu 95 Euro."** → `create_document`

> **„Erzeuge aus Angebot ANG-2026-00123 eine Auftragsbestätigung."** → `convert_document`

> **„Erstelle aus dem Auftrag einen Lieferschein."** → `create_delivery_note`

> **„Erstelle eine Abschlagsrechnung über 30 Prozent."** → `create_downpayment_invoice`

> **„Welche Rechnungen sind überfällig?"** → `list_overdue_invoices`

> **„Sende für RE-2026-00342 eine Zahlungserinnerung."** → `send_dunning`

> **„Buche auf RE-2026-00342 eine Zahlung von 500 Euro."** → `record_payment`

> **„Erstelle die nächste Mahnstufe."** → `create_dunning`

Vollständige Tool-Referenz (alle 98 Tools, nach Bereichen gruppiert, je ein Beispielkommando): [docs/MCP.md](MCP.md#3-verfügbare-tools).

---

## 8. Problembehebung

| Problem | Lösung |
|---|---|
| „Kein Unternehmen eingerichtet" | Zuerst unter **Einstellungen** die Firmendaten speichern. |
| Festschreiben schlägt fehl | Die Meldung nennt die fehlende Pflichtangabe (z. B. Leistungszeitpunkt, Steuernummer). Ergänzen und erneut versuchen. |
| „Unable to open the database file" | `npm run db:migrate` ausführen; DATABASE_URL in `.env` prüfen. |
| Reverse Charge / Kleinunternehmer | Schema in der Rechnung wählen — der Pflichthinweis wird automatisch ergänzt und kein USt-Satz ausgewiesen. |

---

Fragen oder Fehler? → [GitHub-Repository](https://github.com/c-sakel/open-invoice-germany) · Beitragen: [CONTRIBUTING.md](../CONTRIBUTING.md)
