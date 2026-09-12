# Anleitung — OpenInvoice Germany

Diese Anleitung führt dich von der Installation bis zur ersten fertigen, rechtssicheren Rechnung.

> ⚠️ Keine Steuer-/Rechtsberatung. Rechtliche Grundlagen mit Quellen: [COMPLIANCE.md](../COMPLIANCE.md).

---

## 1. Installation (Solo, ohne Server)

Voraussetzung: [Node.js](https://nodejs.org) ≥ 20.

```bash
git clone https://github.com/automationsmanufaktur-labs/open-invoice-germany.git
cd open-invoice-germany
npm install
cp .env.example .env        # Default: SQLite-Datei prisma/dev.db
npm run db:migrate          # legt die Datenbank an
npm run dev                 # startet http://localhost:3000
```

Optional Demo-Daten: `npm run db:seed` (1 Beispiel-Unternehmen, 1 Kunde, Produkte, eine festgeschriebene Rechnung).

Deine Daten liegen in `prisma/dev.db` — eine einzige Datei, die nur dir gehört. **Sichere sie regelmäßig** (kopieren genügt).

---

## 2. Erste Schritte in der App

Die linke Seitenleiste gliedert sich in drei Gruppen — **Übersicht** (Dashboard, ohne eigene Überschrift/Klappfunktion — ein einfacher Link), **Verkauf** (Angebote, Auftragsbestätigungen, Proforma, Lieferscheine, Rechnungen, Gutschriften, Wiederkehrend, Mahnwesen) und **Verwaltung** (Kunden, Produkte, Benachrichtigungen, Einstellungen). Die Gruppen *Verkauf* und *Verwaltung* lassen sich per Klick auf die Überschrift auf-/zuklappen; der Zustand wird je Gruppe im Browser gemerkt (übersteht ein Neuladen). Navigierst du in eine zugeklappte Gruppe hinein, öffnet sie sich einmalig automatisch. Über den Pfeil unten links lässt sich die gesamte Seitenleiste zusätzlich auf reine Icons einklappen.

### Schritt 1 — Unternehmen einrichten (`Einstellungen`)
Beim ersten Start wirst du hierher geführt. Trage deine Firmendaten ein. Pflicht für rechtskonforme Rechnungen (§ 14 UStG):
- **Firmenname + vollständige Anschrift**
- **Steuernummer ODER USt-IdNr.** (mindestens eines)
- Bankverbindung (für den Zahlungshinweis)

Wähle dein **Standard-Steuerschema** (Regelbesteuerung oder Kleinunternehmer § 19). Speichern → fertig.

### Schritt 2 — Kunden anlegen (`Kunden → Neuer Kunde`)
Name, Anschrift, Typ (B2B/B2C). Die USt-IdNr. ist nur bei innergemeinschaftlichen Lieferungen/Leistungen Pflicht. Für Behörden trägst du die **Leitweg-ID** ein.

### Schritt 3 — (optional) Produkte anlegen (`Produkte`)
Ein Katalog spart Tipparbeit — du kannst Positionen aber auch direkt in der Rechnung eintippen.

### Schritt 4 — Rechnung erstellen (`Neue Rechnung`)
Der Editor ist derselbe für Rechnung, Angebot/AB/Proforma und Lieferschein, läuft einspaltig (ein Block unter dem anderen) und deckt sich ab Phase 13b in folgenden Punkten: Kunde per Suche wählen (oder direkt im Editor über „+ Neuer Kunde" anlegen, ohne die Seite zu verlassen), Steuerschema, **Rechnungsdatum** (leer = Datum der Anlage) und **Leistungsdatum** — ein Haken „entspricht dem Rechnungsdatum" koppelt das Leistungsdatum ans Rechnungsdatum, bis du ihn entfernst, dann bleibt dein zuletzt eingetragenes Leistungsdatum stehen. **„Fällig am"** ist ein gekoppeltes Paar aus Datum **und** Tageszahl: gibst du ein Datum ein, springt die Tageszahl (Abstand zum Rechnungsdatum) automatisch mit, gibst du stattdessen eine Tageszahl ein (z. B. „14"), berechnet sich das Datum daraus. Ein Feld **„Betreff"** erscheint als eigene fette Zeile über dem Kopftext im PDF **und** — sofern gefüllt — als Notiz in der E-Rechnung (XRechnung/ZUGFeRD).

Positionen per Produktsuche (Link „Produkt auswählen" direkt in der Zeile) oder frei erfassen. Über das Zeilenmenü (⋯) lässt sich der Zeilentyp jederzeit zwischen Position, Überschrift, Textblock und Zwischensumme wechseln, Zeilen per Drag-and-Drop oder `Alt+↑`/`Alt+↓` umsortieren; `Enter` in der letzten Zeile legt eine neue an. Ein Segmentumschalter „Preise: netto/brutto" oberhalb der Positionstabelle zeigt zusätzlich den Bruttopreis je Position an — gespeichert wird immer netto. Unter den Positionen blendet der Link „**+ Gesamtrabatt**" vier Felder für einen Beleg-Rabatt/-Aufschlag (Prozent **und** Festbetrag, je addiert, plus Freitextgrund) ein — anders als der Positionsrabatt gilt er für den gesamten Beleg. Die Summe wird live berechnet; über „**Vorschau**" lässt sich das PDF des aktuellen, noch ungespeicherten Entwurfs jederzeit ansehen (mit dem Hinweis „ENTWURF"/Wasserzeichen „VORSCHAU", schreibt nichts in die Datenbank). „**Als Entwurf anlegen**" speichert die Rechnung als **Entwurf** — frei änder- und löschbar, noch **ohne Rechnungsnummer**.

Das Anhänge-Panel steht bereits im Neuanlage-Editor bereit: lädst du dort — noch bevor du explizit auf „Speichern" geklickt hast — eine Datei hoch, speichert die App den Beleg automatisch als **Entwurf** (derselbe Weg wie der Speichern-Knopf, nur ohne Wechsel auf die Detailseite) und hängt die Datei daran an. Fehlen dabei Pflichtfelder, bricht der Upload mit einer Fehlermeldung ab, ohne Beleg oder Anhang anzulegen. Verlässt du den Editor mit ungespeicherten Änderungen über die Befehlspalette (`Strg`/`Cmd`+`K`), fragt eine Bestätigung nach, bevor die App wirklich wechselt — genau wie beim Zurück-Link und beim Schließen des Browser-Tabs.

### Schritt 5 — Festschreiben
Auf der Rechnungs-Detailseite: „**Festschreiben**". Dabei passiert (GoBD-konform):
- Die Pflichtangaben werden geprüft (fehlt etwas, bekommst du eine klare Meldung).
- Eine **fortlaufende Rechnungsnummer** wird vergeben (z. B. `RE-2026-0001`).
- Die Rechnung wird **unveränderbar**. Änderungen sind ab jetzt gesperrt.

### Schritt 6 — Exportieren
Die Rechnungs-Detailseite zeigt das **PDF direkt eingebettet** in der Seitenmitte (PDF-Ansicht deines Browsers im A4-Format; ohne eingebauten Viewer ein Link „PDF öffnen" als Download-Fallback). Rechts daneben fasst die **Statuskarte** Status, Kunde, Rechnungs-/Leistungsdatum, Fälligkeit und Brutto kompakt zusammen. Mit den Pfeilen `‹`/`›` neben dem Zurück-Link (oder `Alt+←`/`Alt+→` auf der Tastatur — unter Windows/Linux überlagert das den Browser-Zurück/Vor-Shortcut, siehe [LIMITATIONEN.md](LIMITATIONEN.md)) blätterst du zum vorherigen/nächsten Beleg der zuletzt geöffneten Liste, ohne zurückzuspringen. Eine interne Notiz (falls vorhanden) steht direkt darunter, immer sichtbar; die **Positionen** darunter sind ein einklappbarer Abschnitt (Kopfzeile zeigt Anzahl + Nettosumme, auch ohne Aufklappen).

Der Knopf **PDF** in der Kopfzeile (auch bei Entwürfen aktiv) öffnet die klassische „sonstige Rechnung" für E-Mail/Druck in einem neuen Tab — dasselbe PDF steht zusätzlich direkt eingebettet auf der Seite, s. o. Die E-Rechnungs-Exporte liegen im „**Mehr**"-Menü oben rechts:
- **XRechnung (XML)** — die strukturierte E-Rechnung nach EN 16931 für B2B/Behörden.
- **ZUGFeRD (PDF)** — Hybrid: lesbares PDF mit eingebettetem E-Rechnungs-XML.

Dasselbe „Mehr"-Menü bündelt außerdem Duplizieren, Teilgutschrift, Stornieren und die Lieferschein-Konvertierung — nur die im aktuellen Status tatsächlich erlaubten Einträge erscheinen.

### Schritt 7 — Zahlung & Mahnwesen (Rechnungs-Detailseite, `/mahnwesen`)
Zahlung und Mahnwesen sind Teil der Statuskarte auf der Rechnungs-Detailseite (kein eigener Reiter):
- **Zahlung buchen** — der Button „Zahlung erfassen" oben springt zum gleichnamigen, einklappbaren Abschnitt innerhalb der Statuskarte (bei offenem Betrag automatisch aufgeklappt); Teil- oder Vollzahlung, der Status springt auf *teilbezahlt* bzw. *bezahlt*.
- **Nächste Mahnstufe** — erzeugt die nächste fällige Mahnung nach den unter „Einstellungen → Mahnwesen" konfigurierten **Mahnstufen** (frei editierbar: Name, Tage nach Fälligkeit, neue Zahlungsfrist, Mahnkosten, Zinsberechnung an/aus, 40-€-Pauschale an/aus — vier Standardstufen sind vorbelegt, entsprechen aber keiner gesetzlichen Vorgabe). Mahnkosten sind erst ab der 2. Stufe zulässig (§ 288 Abs. 5 BGB, siehe [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 12); **Verzugszins** (taggenau, 5 Pp B2C/9 Pp B2B über dem jeweils gültigen Basiszins — bei einem Halbjahreswechsel innerhalb der Verzugsperiode stückelt die Mahnung den Zins abschnittsweise und weist jeden Abschnitt einzeln aus) und **40-€-Pauschale** (nur B2B, einmalig je Rechnung) greifen, wenn die jeweilige Stufe das vorsieht. Jede Mahnung gibt es als PDF. Über **Mahnprozess pausieren/beenden** lässt sich eine Rechnung vorübergehend (mit Datum) oder dauerhaft von weiteren automatischen Mahnungen ausnehmen.
- Die Seite **`/mahnwesen`** zeigt eine Übersicht aller überfälligen, offenen Rechnungen (Fälligkeits-„Aging" in Tagesgruppen, Summe offener Beträge, nächste fällige Stufe je Rechnung) über alle Kunden hinweg.
- **Automatisierung:** Unter „Einstellungen → Mahnwesen" steuerst du **Auto-Erstellung** (Default an) und **Auto-Versand** (Default **aus** — bewusst konservativ, erst nach Prüfung der Vorlagen/Mahnstufen aktivieren) global sowie je Stufe (`Auto-Versand` als Schalter an der einzelnen Mahnstufe). Ist beides aktiv, verschickt der eingebaute Scheduler (siehe Schritt 8) fällige Mahnungen ohne manuelles Zutun per E-Mail.
- **Basiszinssatz pflegen:** ebenfalls unter „Einstellungen → Mahnwesen" — eine Tabelle statt eines einzelnen Feldes, weil sich der gesetzliche Basiszinssatz zweimal jährlich ändert (§ 288 Abs. 1 Satz 2 BGB, Bekanntgabe der Deutschen Bundesbank zum 01.01./01.07.). Anlegen/Ändern/Löschen je Stichtag (Satz in Prozent, intern Basispunkte); der letzte verbleibende Eintrag lässt sich nicht löschen. Eine neue Mahnung übernimmt automatisch den zum Verzugszeitraum passenden Satz — bereits erstellte, festgeschriebene Mahnungen ändern sich dabei nicht (GoBD-Snapshot). Auch per REST (`/api/v1/BaseInterestRate`) und MCP (`list_base_interest_rates`/`set_base_interest_rate`/`delete_base_interest_rate`, siehe [MCP.md](MCP.md)) pflegbar.

### Schritt 8 — Eingebauter Scheduler, wiederkehrende Rechnungen / Abos (`Abos`, „Einstellungen → Automatisierung")
Die App bringt einen **eingebauten Scheduler** mit: im laufenden Prozess (`npm run dev`/`next start`, auch im Docker-Image) prüft ein Intervall-Loop automatisch alle paar Minuten, ob Mahnungen fällig sind oder Abo-Rechnungen erzeugt werden müssen (Steuerung über `SCHEDULER_ENABLED`/`SCHEDULER_INTERVAL_MINUTES`, siehe `.env.example`). Unter „Einstellungen → Automatisierung" siehst du die letzten Läufe (Zeitpunkt, Status, Zusammenfassung) und kannst per Knopf **„Jetzt prüfen"** sofort einen Lauf anstoßen.

Für regelmäßige Leistungen (Wartung, Retainer, Miete): Lege ein **Abo** an — Kunde, Positionen, Rhythmus (wöchentlich bis jährlich), Startdatum, optional Enddatum. Wahlweise werden die erzeugten Rechnungen **automatisch festgeschrieben**. **Jetzt Rechnung erzeugen** auf der Abo-Seite erstellt sofort die nächste Rechnung.

**Vorrangregel bei Abo-Läufen (§28–§30):** Jede erzeugte Rechnung läuft seit Phase 14a über denselben Erstellungspfad wie eine manuell angelegte Rechnung. Was das Abo selbst festlegt — Steuerschema, Währung, Notiz, Positionen und die im Abo hinterlegte **Zahlungsfrist** —, überstimmt in jedem Fall eine abweichende Kundenvorgabe. Alles, was das Abo nicht kennt, kommt dagegen jetzt aus den **Kundenvorgaben**: Zahlungsart, Ansprechpartner, Rechnungs-/Lieferadresse, **Kundenrabatt**, Bestellreferenz, Zahlungsbedingungstext sowie Kopf-/Fußtextvorlage. Die Abo-Detailseite zeigt einen eigenen Block „Aus den Kundenvorgaben übernommen" mit den aktuell wirksamen Werten. **Prüfabfrage vor dem Deploy dieser Version:** Hat ein Kunde mit laufendem Abo einen hinterlegten `Kundenrabatt` (§28) größer 0 %? Falls ja, sinkt der Rechnungsbetrag ab dem nächsten Lauf dieses Abos entsprechend — das ist die beabsichtigte Fehlerbehebung, kein Defekt, sollte aber vor dem ersten Lauf nach dem Update bekannt sein. **Zweite Prüfabfrage:** Ist bei einem Bestandsabo der Leistungszeitraum-Text (`showPeriodText`) ausgeschaltet UND existiert eine als Standard markierte Kopftextvorlage (Einstellungen → Textvorlagen, Position „Kopf") für Rechnungen? Falls ja, bekommt die ab dem nächsten Lauf dieses Abos erzeugte Rechnung erstmals genau diesen Kopftext, statt wie bisher ganz ohne Kopftext zu bleiben — ebenfalls die beabsichtigte Angleichung an den manuellen Rechnungspfad (R5), aber eine sichtbare PDF-Änderung für Bestandsabos.

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

- Seit **2025** musst du im B2B E-Rechnungen **empfangen** können; **versenden** wird ab 2027/2028 Pflicht (Details + Quellen: [COMPLIANCE.md](../COMPLIANCE.md)).
- Der **XRechnung-XML-Teil ist führend** — das PDF ist nur die menschenlesbare Beilage.
- Die App validiert jede XRechnung gegen die EN-16931-Kernregeln, bevor sie ausgeliefert wird. Die vollständige amtliche Prüfung (KoSIT-Validator) läuft im CI.
- **ZUGFeRD/Factur-X** (PDF mit eingebettetem XML) ist über den optionalen Mustang-Sidecar geplant (siehe [ARCHITEKTUR.md](ARCHITEKTUR.md)).

### Steuerschemata und Pflichthinweise (Phase 12b)

Im Beleg-Editor wählst du unter „Steuerschema" eine von **sieben** Optionen — Details, Normen und Fixtures dazu stehen in [COMPLIANCE.md](../COMPLIANCE.md) § 1, 8 und 9:

| Auswahl im Editor | Bedeutung |
|---|---|
| Regelbesteuerung | Normalfall, 19 %/7 %. Kein Pflichthinweis. |
| Kleinunternehmer (§ 19) | Kein USt-Ausweis; Pflichthinweis wird eingefügt. |
| Differenzbesteuerung (§ 25a) | Gebrauchtwaren/Kunst/Sammlerstücke; kein USt-Ausweis, Marge nicht sichtbar. |
| Reverse Charge (§ 13b) | Steuerschuld geht auf den Empfänger über; braucht dessen USt-IdNr. |
| Innergem. Lieferung (§ 6a) | Steuerfreie EU-Warenlieferung; braucht USt-IdNr. beider Seiten + Leistungsdatum/-zeitraum. |
| Innergem. Leistung (§ 3a Abs. 2) | Steuerschuld beim EU-Empfänger; braucht USt-IdNr. beider Seiten. |
| Ausfuhrlieferung (§ 6) | Steuerfreie Lieferung außerhalb der EU; Empfänger muss außerhalb der EU liegen. |

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
- **Mehrbenutzer/Internet**: Das MVP hat noch **keine eingebaute Anmeldung**. Betreibe es lokal oder hinter einem Auth-Proxy. Siehe [SECURITY.md](../SECURITY.md).
- **PostgreSQL/Docker**: `docker compose up --build` (siehe README).
- **API-Dokumentation im Container**: `/api/docs` (Swagger UI) und `GET /api/v1/openapi.json` lesen die committete Datei `openapi/openapi.json` zur Laufzeit relativ zu `process.cwd()` — das Docker-Image kopiert dieses Verzeichnis in die runner-Stage (`Dockerfile`, Fix-Welle Phase 10). Bei einem selbst angepassten Dockerfile darauf achten, `openapi/` mit auszuliefern, sonst liefert `/api/docs` einen 500er.

---

## 6. Briefpapier, Layouts, Nummernkreise, Druckoptionen & GiroCode

Unter **„Einstellungen"** findest du seit Phase 7 zusätzliche Seiten für das Erscheinungsbild und die Nummerierung deiner Belege; seit Phase 11b ist das Erscheinungsbild in die Reiter „Briefpapier" / „Layouts" / „Druckoptionen" unter `Einstellungen → Briefpapier` aufgeteilt.

### Briefpapier einrichten (Reiter „Briefpapier")
- **Logo hochladen**: PNG oder JPEG, max. **2 MB**. Wird je nach Layout oben rechts oder oben links auf jedem Beleg-PDF angezeigt.
- **Logogröße**: Schieberegler + Zahlenfeld „Breite im PDF (mm)", 10–140 mm. Die Höhe wird automatisch auf 35 mm begrenzt — ein breites/flaches Logo wird bis zu dieser Breite groß, ein hohes/schmales Logo wird schon vorher durch die Höhengrenze gebremst, damit es nicht in den Adressblock hineinläuft. **Ausnahme Layout „modern"**: dort ist das Logo zusätzlich auf die Höhe des Kopfbalkens begrenzt (≈ 15 mm) — ein breites Logo wirkt dort kleiner als in den übrigen Layouts, auch bei hoher eingestellter Breite.
- **Hintergrundbild** (optional): PNG oder JPEG, max. **5 MB**, ganzseitig hinter dem Beleginhalt — nur sichtbar, wenn „Hintergrund anzeigen" aktiv ist.
- **Primärfarbe**, **Ränder** (oben/rechts/unten/links, mm) und **Schriftgröße** (pt) bestimmen Optik.
- **Absenderzeile** und Fußzeile (automatisch aus den Stammdaten in vier Spalten, oder drei freie Textfelder links/mittig/rechts).
- **Vorschau**: Link auf der Seite öffnet eine Musterrechnung/-lieferschein mit dem aktuell gespeicherten Layout.
- Änderungen wirken sofort auf **alle** künftigen PDF-Abrufe, auch bei bereits festgeschriebenen Belegen (Nachdruck) — der rechtlich maßgebliche Beleginhalt (Zahlen, Positionen, Nummer) bleibt davon unberührt (siehe [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 6).

### Layouts (Reiter „Layouts", Phase 11b)
Sieben fest vorgegebene PDF-Layouts (**standard**, **schlicht**, **klassik**, **modern**, **blau**, **schwarz**, **kompakt**) — je eine Vorschaukachel. Die Auswahl gilt **je Belegtyp** (Rechnung, Angebot, Auftragsbestätigung, Proforma, Gutschrift, Lieferschein, Mahnung) und zusätzlich als **Organisationsstandard** (Fallback für Belegtypen ohne eigene Zuordnung) — es ist also **kein** einziges Layout mehr org-weit fest, sondern eine Auflösungsreihenfolge: Beleg-Override (im Editor gesetzt) **>** Typ-Zuordnung **>** Organisationsstandard **>** „standard". Ein Kachel-Klick ändert zunächst nur eine lokale Vorschau; „Für <Typ> übernehmen" bzw. „Als Standard für alle" speichert die Auswahl erst explizit. Zusätzlich lässt sich auf einem einzelnen **Entwurf** im Editor unter „Weitere Optionen" ein abweichendes Layout nur für diesen einen Beleg wählen — beim Festschreiben wird diese Wahl eingefroren und ändert sich danach nicht mehr, auch wenn du später den Organisationsstandard/die Typ-Zuordnung änderst (Nachdrucke bleiben stabil).

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

Auf der Kunden-Detailseite (`Kunden → <Kunde>`) gibt es seit Phase 8a vier zusätzliche Reiter.

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

## 6b. Dashboard, Filter, Schnellaktionen, Benachrichtigungen & Abo-Bearbeiten (Phase 8b)

### Dashboard (Startseite nach Anmeldung)
Bist du angemeldet, zeigt die Startseite (`/`) statt der Marketingseite dein **Dashboard**: offene, fällige und überfällige Beträge, „fällig diese Woche", teilbezahlte Rechnungen, wie viele Rechnungen ein Mahnschreiben benötigen würden, ein Aging-Diagramm (0–7 / 8–30 / 31–60 / 61–90 / über 90 Tage überfällig), den **Nettoumsatz** im laufenden Monat, die letzten fünf Belege und die Anzahl offener Angebote. Das Aging auf dem Dashboard zählt den heutigen Fälligkeitstag bereits mit (Frühwarnung) — die Mahnübersicht unter `/mahnwesen` zählt erst ab dem Folgetag (Eskalationslogik); beide zeigen deshalb bei derselben Rechnung leicht unterschiedliche Buckets, siehe [LIMITATIONEN.md](LIMITATIONEN.md).

**Vier Diagramme (Phase 12e), vier verschiedene Bemessungsgrundlagen — bewusst so benannt:**

- „Umsatz je Monat" (Balken, Dashboard) und „Umsatz je Monat" (Linie, Kundenseite) — **Nettoumsatz**, 12 Monate. Dieselbe Grundlage wie die Kachel „Nettoumsatz (laufender Monat)" auf dem Dashboard und „Nettoumsatz" auf der Kundenseite: nur Entwürfe (Status DRAFT) fehlen, ein storniertes Original bleibt mit vollem Betrag in seinem Ausstellungsmonat stehen, die Storno-Gutschrift mindert separat den Monat der Stornierung — über die Zeit gleicht sich das exakt aus (periodengerechte/accrual-Sicht). Gutschriften (auch frei angelegte, nicht nur Stornos) sind bereits mit ihrem negativen Betrag eingerechnet.
- „Top 5 Kunden" (waagerechte Balken, Dashboard) — dieselbe Nettoumsatz-Grundlage, nach Kunde gruppiert.
- „Rechnungsstatus (Anzahl)" (Ring, Dashboard) — zählt **Belege**, keinen Betrag (Offen/Überfällig/Bezahlt).
- „Überfällig nach Alter (offen, brutto)" (waagerechte Balken, Dashboard/Aging) — der **offene Bruttobetrag** je Alters-Bucket, nicht netto und nicht mit der Umsatzreihe zu verwechseln.

Jeder Wert erscheint beim Überfahren mit der Maus als Tooltip (Monat/Kunde + Betrag); unter jedem Diagramm steht dieselben Werte zusätzlich als für Screenreader zugängliche Tabelle (visuell ausgeblendet, aber im Code vorhanden) — die Diagramme sind damit ohne Maus und ohne Sehen bedienbar.

### Status-Tabs, Sofortfilter & Kopfkennzahlen (Rechnungen, Angebote/AB/Proforma, Lieferscheine, Abos; Phase 13a)
Jede Listenseite (`/rechnungen`, `/dokumente`, `/lieferscheine`, `/abos`) zeigt oben **Status-Tabs** statt eines Status-Auswahlfelds: ein Klick auf einen Tab (z. B. „Überfällig") filtert sofort, die Zahl neben dem Tab-Namen zeigt, wie viele Belege dort stehen — bezogen auf die übrigen aktiven Filter, unabhängig vom gerade gewählten Tab. Bei Angeboten/Auftragsbestätigungen kommen zwei abgeleitete Tabs hinzu, „Berechnet" und „Teilweise berechnet" — sie zeigen den **Abrechnungsstand** (ob/wieviel bereits in Rechnung gestellt wurde), nicht den Beleg-Status selbst; bei mehr als 5.000 Belegverknüpfungen (Relationszeilen, nicht Belegen) je Organisation entfallen diese zwei Tabs (lieber keine Zahl als eine falsche, siehe [LIMITATIONEN.md](LIMITATIONEN.md)) — ein gemerkter Link wie „Berechnet" liefert in diesem Fall dann still keine Treffer statt einer veralteten Liste. Die Status-Tabs überlappen sich bewusst dort, wo es die Statuslogik selbst tut — eine teilbezahlte, überfällige Rechnung erscheint unter „Teilbezahlt" **und** unter „Überfällig".

Die Filterleiste darunter filtert **ohne eigenen „Filtern"-Knopf**: ein Auswahlfeld oder Datum filtert sofort bei Auswahl, Text- und Betragsfelder nach kurzer Tipppause (rund 300 ms) — ganz ohne JavaScript funktioniert sie weiterhin über die Eingabetaste/das Absenden des Formulars, mit demselben Ergebnis (Betrag/Kunde eingeschlossen — die Umrechnung Euro→Cent bzw. Name→Kunde läuft serverseitig, nicht mehr nur im Browser). Verfügbare Filter (je nach Liste): Volltextsuche, Kunde (Namenseingabe — ohne exakten Treffer zählt die Eingabe als Volltextsuche), Belegtyp/-art, Zeitraum (von/bis), bei Rechnungen zusätzlich Betrag in Euro (von/bis), Zahlungsart und E-Rechnung ja/nein. Jeder Filter landet in der URL und lässt sich damit als Lesezeichen speichern oder teilen. Gutschriften findest du über `/rechnungen?type=CREDIT_NOTE` (kein eigener Menüpunkt).

Darunter zeigen **Kopfkennzahlen** die Summe über die **gefilterte Menge** — nicht nur über die gerade angezeigte Seite der Liste: bei Rechnungen Anzahl, Brutto gesamt, Offen und Überfällig; bei Dokumenten Anzahl und Brutto gesamt; bei Lieferscheinen NUR die Anzahl (Lieferscheine sind kein Steuerbeleg und speichern keine Bruttosumme); Abos zeigen keine Kopfkennzahl. Umfasst die gefilterte Menge mehrere Währungen, wird die Summe mit dem Hinweis „gemischte Währungen" gezeigt statt sie stillschweigend zu addieren.

### Fälligkeit & Herkunft (Phase 13a)
Die Spalte „Fällig" der Rechnungsliste zeigt statt eines nackten Datums eine relative Angabe („in 5 Tagen", „seit 2 Tagen überfällig") — das genaue Datum steht als Tooltip beim Überfahren mit der Maus; bei Überfälligkeit ist der Text dieser Spalte rot. Wurde ein Beleg aus einem anderen erzeugt (z. B. Rechnung aus Angebot/AB, Lieferschein aus Angebot/AB/Rechnung, Rechnung aus einem Abo), zeigt ein kleiner Link unter der Belegnummer die **Herkunft** (z. B. „aus Angebot AN-2026-0007") — ein Klick führt direkt zum Ursprungsbeleg.

### Zeilen-Schnellaktionen
In jeder Zeile einer Liste öffnet das „⋯"-Menü die für **diesen** Beleg im aktuellen Status verfügbaren Aktionen (öffnen, bearbeiten, duplizieren, PDF, XRechnung, per E-Mail senden/erneut senden, Zahlung buchen, Zahlungserinnerung, nächste Mahnstufe, umwandeln, stornieren) — nicht verfügbare Aktionen erscheinen gar nicht erst, kein Rätselraten über deaktivierte Buttons. Zahlung und Versand lassen sich direkt aus der Liste heraus erledigen, ohne die Detailseite zu öffnen. Bei Angeboten/Auftragsbestätigungen bündelt „Umwandeln" (Phase 13a) alle möglichen Ziele — Auftragsbestätigung, Rechnung, Lieferschein — in einem Menüpunkt statt mehrerer einzelner Einträge; welche Ziele angeboten werden, hängt vom Status und (nur bei der Rechnungs-Erzeugung) vom Abrechnungsstand ab: eine bereits umgewandelte Vorlage bietet keine weitere Auftragsbestätigungs-/Rechnungs-Erzeugung mehr an, eine bereits voll abgerechnete Vorlage zusätzlich keine weitere Rechnungs-Erzeugung (§13-15 UStG) — ein Lieferschein lässt sich aus einem Angebot/einer AB weiterhin erzeugen, auch nach vollständiger Abrechnung (Liefern nach Rechnungsstellung ist der Normalfall).

### Kundendetailseite
`Kunden → <Kunde>` zeigt jetzt zuerst eine Übersicht: offener Betrag, überfälliger Betrag, Nettoumsatz, letzte Aktivität, sowie Reiter für alle Rechnungen/Angebote/Lieferscheine/Abos dieses Kunden. Die bisherigen Stammdatenformulare (Adressen, Ansprechpartner, Vorgaben, Kundenfelder) findest du unverändert unter „Bearbeiten" auf dieser Seite.

**Zeitreihe, Ø Zahlungsdauer und Pünktlichkeitsanteil (Phase 12e):** darunter zeigt
eine Liniengrafik den Netto-Umsatz dieses Kunden über die letzten 12 Monate. Zwei
zusätzliche Kacheln fassen sein Zahlungsverhalten zusammen: „Ø Tage bis zur
Zahlung" (Mittelwert zwischen Rechnungsdatum und der zuletzt erfassten Zahlung über
alle bezahlten Rechnungen dieses Kunden) und „Pünktlichkeit" (Anteil der bis zum
Fälligkeitstag beglichenen Rechnungen — der Fälligkeitstag selbst zählt noch als
pünktlich). Beide zeigen „—" statt eines Werts, wenn es (noch) keine bezahlte
Rechnung bzw. keine mit Fälligkeitsdatum gibt — siehe „Grafiken & Auswertungen" in
[LIMITATIONEN.md](LIMITATIONEN.md).

### Belegseite (Phase 13c)
Die Detailseite von Rechnung, Angebot/AB/Proforma und Lieferschein teilt sich seit Phase 13c einen gemeinsamen Rahmen: PDF mittig, Beleg-/Statuskarten rechts.

- **Primäraktion** (Kopfzeile, Rechnungen): statt bis zu fünf gleichwertigen Knöpfen zeigt die Kopfzeile genau **einen** hervorgehobenen Knopf je Status — Entwurf → „Festschreiben", offen → „Als bezahlt markieren" (öffnet den vorbelegten Zahlungsdialog), bezahlt/storniert → „Neue Rechnung". „Neue Rechnung" steht daneben immer als zweiter, unauffälliger Link zur Verfügung, außer er ist bereits die Primäraktion. Bei Angebot/AB/Proforma und Lieferschein zeigt die Kopfzeile stattdessen wie bisher den jeweils ersten verfügbaren Statusübergang (z. B. „Annehmen"); die restlichen Übergänge sowie „Umwandeln" (Auftragsbestätigung/Rechnung/Lieferschein) stehen im „Mehr"-Menü. Fix-Welle 1 (S5): der unauffällige Link „Neue Rechnung" (mit vorbelegtem Kunden) steht seither auf **jeder** Belegseite in der Kopfzeile — auch auf Angebot/AB/Proforma und Lieferschein, nicht nur auf der Rechnungsseite selbst.
- **Zahlungsdialog** (`#zahlung`, nur Rechnungen): „Zahlung erfassen"/„Als bezahlt markieren" öffnen denselben Dialog — vorbelegt mit dem offenen Betrag, dem heutigen Datum und der Standardzahlungsmethode. Gebucht wird **nie** automatisch, erst mit Klick auf „Buchen" im Formular. Ein Link auf `#zahlung` (z. B. aus dem Mahnwesen oder einer Liste) öffnet den Dialog direkt beim Laden der Seite; das ✕ oder Escape schließen ihn wieder, ein erneuter Klick auf denselben Link öffnet ihn erneut.

### Zeitstrahl (Rechnungs-/Angebots-/Lieferschein-Detailseite)
Jede Belegdetailseite zeigt unter „Zeitstrahl" eine chronologische Historie: Anlage, Änderungen, Festschreibung, Versand, Zahlungen, Mahnungen, Statuswechsel, Duplizierung, Umwandlung — alles an einem Ort statt über mehrere Karten verstreut. Diese Historie beginnt erst mit Phase 8b; für ältere Belege fehlen entsprechend frühere Ereignisse, siehe [LIMITATIONEN.md](LIMITATIONEN.md).

### Benachrichtigungen (Glocke oben rechts, `/benachrichtigungen`)
Die Glocke im Kopfbereich zeigt die Anzahl ungelesener Benachrichtigungen und eine Kurzliste; „**Alle anzeigen**" führt zur vollständigen Liste. Benachrichtigt wirst du u. a. bei: Rechnung heute fällig, Rechnung überfällig, nächste Mahnstufe erreicht, Angebot läuft bald ab, E-Mail nicht zustellbar, wiederkehrende Rechnung fehlgeschlagen, ungültige E-Rechnung. Unter „**Einstellungen → Benachrichtigungen**" schaltest du jeden dieser sieben Typen einzeln an/aus und aktivierst optional einen **täglichen E-Mail-Digest** (eine Sammel-E-Mail statt einzelner Benachrichtigungen). Erzeugt werden Benachrichtigungen von einem dritten Scheduler-Job (`notifications`, nach `recurring`/`dunning`) — läuft automatisch mit dem eingebauten Scheduler/Cron aus Schritt 8, kein separater Aufruf nötig.

### Abo bearbeiten (`/abos/[id]/bearbeiten`)
Über „Bearbeiten" auf der Abo-Detailseite (oder das „⋮"-Menü in der Abo-Liste) änderst du ein bestehendes Abo: Titel, Rhythmus (inkl. **täglich**), Start-/Enddatum, maximale Anzahl Läufe, Zahlungsfrist, Positionen, Auto-Festschreiben/-Versand, E-Mail-Vorlage, Leistungszeitraum-Text. Der Kunde selbst ist nicht änderbar — für einen anderen Kunden legst du ein neues Abo an. Änderst du das Startdatum eines Abos, das noch **keine** Rechnung erzeugt hat, zieht das nächste Erzeugungsdatum automatisch mit; hat das Abo bereits mindestens einen Lauf hinter sich, bleibt der bestehende Erzeugungsplan unangetastet (eine nachträgliche Korrektur soll den laufenden Plan nicht zurückspulen).

---

## 6c. Marke & Steuersätze (Phase 12c)

### Marke (`Einstellungen → Marke`)
White-Label für deine Instanz — unabhängig vom Briefpapier (Abschnitt 6, das gilt nur für Beleg-PDFs):
- **Name der Instanz** (max. **40** Zeichen) und **Kurzname/Kürzel** (max. **12** Zeichen) ersetzen „OpenInvoice Germany"/„OI" in Seitenleiste, Kopfzeile, Browser-Tab-Titel und Login-Seite. Leer gelassen gilt weiterhin die Produktvorgabe.
- **Favicon**: **quadratisches PNG**, **32–512 px** Kantenlänge, max. **512 KB**. Kein SVG (bewusst — siehe [LIMITATIONEN.md](LIMITATIONEN.md)).
- **App-Logo**: **PNG oder JPEG**, max. **1 MB** — ersetzt das Kürzel-Badge in der Kopfzeile, wird auf 28 px Höhe angezeigt. Mit hinterlegtem Logo steht **nur noch das Bild** dort (kein Name mehr daneben); der Name bleibt als Barrierefreiheits-Text (`alt`) am Bild sowie im Browser-Tab-Titel erhalten.
- Die Herkunftszeile **„powered by OpenInvoice Germany · AGPL-3.0"** mit Link zum Quellcode bleibt in der Fußzeile **immer** sichtbar, egal welcher Name eingetragen ist — sie ist Bedingung der AGPL-3.0-Lizenz und nicht abschaltbar (siehe [COMPLIANCE.md](../COMPLIANCE.md) Abschnitt 19).

### Steuersätze (`Einstellungen → Belege`)
Die Liste der für neue Beleg-Positionen wählbaren Umsatzsteuersätze ist seit Phase 12c **je Organisation** konfigurierbar (vorher fest 19 %/7 %/0 %):
- **1 bis 10 Einträge**, jeweils eine **ganze Zahl zwischen 0 und 100** (Prozent). Vorgabe bei einer neuen Organisation: **19, 7, 0**.
- Ein Satz lässt sich **nicht** entfernen, solange nur noch ein einziger übrig bliebe (mindestens ein Satz ist immer nötig).
- **Bereits ausgestellte Belege behalten ihren Satz**, auch wenn er später aus der Liste entfernt wird (GoBD, § 51) — Editor, Produktformular und Abo-Formular zeigen einen solchen Satz auf einem bestehenden Entwurf/Datensatz zusätzlich als „**19 % (nicht mehr zulässig)**" in der Auswahl an, damit er beim Speichern nicht verloren geht, aber niemand ihn neu auswählen kann.
- **Teilgutschrift** (`/rechnungen/[id]/teilgutschrift`): die Auswahl bietet zusätzlich zur Org-Liste jeden auf der Original-Rechnung tatsächlich verwendeten Satz als „**geerbt**" an, auch wenn er nicht mehr in der Org-Liste steht — eine Teilgutschrift muss immer zum selben Satz möglich sein wie die Original-Position.
- Der Versuch, eine **neue** Position (oder einen neu gewählten Satz auf einem bestehenden Entwurf) mit einem nicht freigegebenen Satz zu speichern, scheitert mit der Fehlermeldung „**Steuersatz X % ist für diese Organisation nicht freigegeben (Einstellungen → Belege).**" — sowohl im Editor als auch bei Produkten, Abo-Vorlagen, Teilgutschriften und über API/MCP.

---

## 6d. Anfrageprotokoll (`Einstellungen → API → Anfrageprotokoll`, Phase 12d)

Wer die REST-API (`/api/v1`, siehe [docs/API.md](API.md)) nutzt, kann sich fehlgeschlagene und langsame Aufrufe zur Fehlersuche protokollieren lassen:

- **Einschalten**: „Anfragen protokollieren" ist **standardmäßig AUS** — ohne diesen Haken bleibt die Tabelle leer, es entsteht keine einzige Zeile. Zusätzlich „Bodies mitschreiben" schaltet Request- **und** Response-Bodies dazu (Response-Body nur bei Fehlern, Status ≥ 400).
- **Fehler nachvollziehen**: die Tabelle zeigt Zeit, Methode, Pfad, Status (farbig ab 400/500), Dauer und den verwendeten Schlüssel, neueste zuerst; der Filter „nur Fehler (≥ 400)" sowie Filter nach Schlüssel, Pfad und Zeitraum grenzen ein.
- **Detail öffnen**: ein Klick auf eine Zeile öffnet die Detail-Schublade mit Request-ID (identisch mit dem `X-Request-Id`-Header der jeweiligen Antwort — nützlich beim Abgleich mit eigenen Client-Logs), vollständigem Pfad, IP, User-Agent und — falls „Bodies mitschreiben" aktiv war — Request-/Response-Body.
- **Protokoll leeren**: löscht sofort das gesamte Protokoll der eigenen Organisation (Bestätigungsdialog, nicht rückgängig zu machen). Ohne aktiven Scheduler-Lauf (Abschnitt „Schritt 8") wächst die Tabelle sonst bis zum nächsten automatischen Aufräumen weiter — Aufbewahrung (Tage) und maximale Zeilenzahl je Organisation sind ebenfalls hier einstellbar.

**Hinweis zum Kopfdaten-Modus:** Auch ohne „Bodies mitschreiben" speichert „Anfragen protokollieren" bereits Pfad **inklusive Query-String**, IP-Adresse und User-Agent jeder Anfrage — Parameter mit verdächtigem Namen (`token`, `secret`, `password`, `apiKey`, `iban`, `bic`, `email`, …) werden dabei vor dem Speichern automatisch geschwärzt.

**Warnung:** „Bodies mitschreiben" schreibt die tatsächlich gesendeten/empfangenen JSON-Inhalte (bis 2 KB, gekürzt) in die Protokolltabelle — das können Kundendaten sein (Namen, Adressen, Beträge). Bekannt gefährliche Feldnamen (`token`, `secret`, `password`, `apiKey`, `iban`, `bic`, `authorization`, …) werden vor dem Speichern automatisch geschwärzt, ein genereller Datenschutzfilter ist das aber nicht — nur einschalten, wenn die konkrete Fehlersuche das rechtfertigt, und danach wieder ausschalten oder das Protokoll leeren.

---

## 6e. Belegvorlagen & Tags (Phase 13d)

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

## 7. Per Sprache mit Claude Code (MCP)

Statt Formulare auszufüllen, kannst du OpenInvoice auch **per Sprache** über einen mitgelieferten **MCP-Server** bedienen — z. B. mit Claude Code oder Claude Desktop. Einrichtung, Datenschutz-Hinweise (DSGVO/Art. 28) und die vollständige Tool-Liste stehen in **[docs/MCP.md](MCP.md)**; lies das dort zuerst, bevor du echte Kundendaten per Cloud-LLM verarbeiten lässt.

Alle wichtigen Funktionen aus dieser Anleitung sind auch als MCP-Tool erreichbar — Claude ruft dieselben, gleich validierten Funktionen auf wie UI und API (§55 des Lastenhefts, keine Bypass-Pfade). Beispielsätze:

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

Fragen oder Fehler? → [Issues auf GitHub](https://github.com/automationsmanufaktur-labs/open-invoice-germany/issues) · Beitragen: [CONTRIBUTING.md](../CONTRIBUTING.md)
