# Ledger Phase 12c — Marke und Steuersaetze

Branch `phase-12c/marke-steuersaetze` aus Fork-main 75fc524, Plan `docs/superpowers/plans/2026-09-08-phase-12c-marke-steuersaetze.md`, Spec Pakete C+D. Modelle: sonnet/opus. Ergebnis: 1944 Tests gruen, Postgres-Skript 19 Faelle gruen, validate:erechnung 39/39, Docker-Build verifiziert, Smoke 18/18 + Fix-Smoke 8/8.

## Commits
- 8fb2938 feat(marke): BrandingSettings um appName/appShortName/faviconPath/appLogoPath erweitert (Phase 12c, Task 1)
- 57e547e feat(marke): Favicon-/App-Logo-Upload und zwei oeffentliche Auslieferungsrouten (Phase 12c, Task 2)
- beee711 feat(marke): dynamische Metadaten, Marke in beiden Huellen, feste AGPL-Herkunftszeile (Phase 12c, Task 3)
- 2e6d14f fix(marke): Pfadfelder nur per Upload setzbar, Containment und ETag der Asset-Routen (12c Task 2 Fix 1)
- fc3d09c feat(marke): Einstellungen-Reiter Marke mit Name, Kurzname, Favicon und Logo (Phase 12c, Task 4)
- 37b9743 feat(steuersaetze): org-eigene Steuersatz-Liste mit assertAllowedTaxRates in den Domain-Kernen (Phase 12c, Task 5)
- 1ce689a fix(steuersaetze): Teilgutschrift prueft Steuersaetze mit geerbten Saetzen des Originals (12c Task 5 Fix 1)
- 3f3ce8e feat(steuersaetze): Editor, Einstellungen -> Belege und MCP nutzen die org-eigene Liste (Phase 12c, Task 6)
- f88fc4d fix(marke): Markenkonstanten client-sicher, Formular-A11y, Whitespace
- 71a9aff docs(marke,steuersaetze): Anleitung, Limitationen, Architektur, MCP/API und COMPLIANCE nachgefuehrt (Phase 12c, Task 7)
- a33d443 fix(branding): Fix-Welle Phase 12c — C1 (Icon-Fallback darf nie 500 werfen)
- 17c869c fix(marke,steuersaetze): Fix-Welle Phase 12c — I1 (MarkeForm-Datenverlust) + I2 (Org-Steuersatzliste fehlte in drei Formularen)
- 0b60e16 fix(marke,steuersaetze): Fix-Welle Phase 12c — Minor-Befunde M1-M7, M9 (M8 als Anmerkung uebernommen)
- da543fe fix(marke,steuersaetze): Fix-Welle Phase 12c — Korrektur M5 (kein Nicht-Async-Export aus use-server-Datei)
- c29ef91 fix(mcp): TaxRateNotAllowedError als lesbare Meldung in Produkt-, Abo- und Gutschrift-Tools (12c Fix 2)

## Verlauf, Befunde, Rulings (SDD-Ledger)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 (BrandingSettings: prisma beide Schemata, settings.ts, domain, Migration, PG-Fall 18) vs T5 (DocumentSettings taxRatesJson: prisma beide Schemata, schemas/index.ts, Migration, PG-Fall 19) | beide prisma/schema.prisma + prisma generate | sequentiell T1 vor T5 |
| T2 (Upload-Route, proxy PUBLIC_PREFIXES, png-size, Icon-Routen, proxy-public.test exakt) | konsumiert T1-Felder | nach T1; parallel zu T5 (disjunkt) |
| T3 (layout generateMetadata, AppShell/Sidebar/Topbar/SlimShell, AGPL-Zeile, Mailtexte) | konsumiert T1/T2 | nach T2 |
| T4 (nav.ts Reiter Marke, marke/page, MarkeForm) | konsumiert T1–T3 | nach T3; parallel zu T6 (disjunkt) |
| T6 (editor constants/draft/LineRow/RecipientBlock, TaxRatesField, MCP) | konsumiert T5 | nach T5 |
| T7 Doku/Smoke/Gate | letzter, kein eigenes Review | nach T4+T6 |
| Planer-Rulings uebernommen: taxRatesSchema ohne transform; inheritedTaxRates fuer abgeleitete Belege; Favicon nur PNG; proxy-public.test.ts anpassen | — | ok |
Reihenfolge: T1 -> (T2 ∥ T5) -> (T3 ∥ T6) -> T4 -> T7. Modelle: sonnet/opus.
Hinweis fuer 12d-Ledger: scripts/test-postgres-migrations.sh Tabellenzusicherung 43 -> 45 (Z. 42, 516, 618, 651) + neue Faelle.
T1 dispatcht. BASE 75fc524.
Task 1: implementiert 8fb2938 (1897 Tests; PG-Skript lokal mit Docker gruen, 18 Faelle). Review dispatcht. T2 + T5 parallel dispatcht (BASE 8fb2938).
CI main 75fc524 (12b): alle 4 Jobs gruen.
Task 1: complete (Approved, 8fb2938). Pruefpunkt Abschluss-Review: faviconPath/appLogoPath duerfen ueber Settings-PATCH/MCP nicht frei setzbar sein (Task 2 Upload-Route ist einzige Quelle) — ggf. aus dem PATCH-Schema omit.
Task 2: implementiert 57e547e (content-length im Testhelfer). Review dispatcht. Task 3 dispatcht (BASE 57e547e).
Task 2: review — Important (Sicherheit): faviconPath/appLogoPath ueber MCP update_branding_settings (+ API PATCH?) frei setzbar, oeffentliche Route liest ohne Containment -> Pfadausbruch. Minor: icon-Route Content-Type hart, kein ETag. Fix-Runde 1/5 an Task-2-Implementer: omit in MCP+API-Schema UND Containment (resolve+prefix) in den Routen (Defense in depth), ETag/Version.
Task 3: implementiert beee711 (AuthForm-Literal wegen Client-Bundle; safeBrand exportiert; Favicon ?v=). Review dispatcht. Task 4 dispatcht (BASE beee711).
Task 3: complete (Approved, beee711). Fuer Task 7: DEFAULT_APP_NAME-Duplikat in AuthForm per Test absichern; loadBrand in layout per React.cache() dedupen.
Task 2: fix round 1/5 (2e6d14f: omit in MCP/API/PUT, Containment-Helfer, ETag; PUT /api/settings/branding hatte vorher gar keinen Pfadschutz). Scoped Re-Review dispatcht.
Task 4: implementiert fc3d09c (Konstanten in MarkeForm dupliziert wegen Prisma-Import). Review dispatcht. Ruling fuer Task 7: DEFAULT_APP_NAME/SHORT_NAME in client-sicheres Modul src/lib/brand-defaults.ts, von brand.ts/AuthForm/MarkeForm importiert (statt Test-Absicherung).
Task 2: complete (Re-Review Clean, 2e6d14f).
Task 4: complete (Approved, fc3d09c). Fuer Task 7: MarkeForm Datei-Inputs mit <label htmlFor>, Whitespace-only -> null, issues anzeigen.
Task 5: implementiert 37b9743 (1928 Tests, PG 19/19; Editor-Union bewusst fuer Task 6 belassen). Review dispatcht. Task 6 dispatcht (BASE 37b9743).
Task 5: review — Critical: createPartialCreditNote (credit.ts) ohne assertAllowedTaxRates (Teilgutschrift-Zeilen mit beliebigem 0–100-Satz, sofort festgeschrieben). Minor: createProduct-Check vor Transaktion. Fix-Runde 1/5 an Task-5-Implementer (credit.ts + Test, disjunkt zu Task 6).
Task 5: fix round 1/5 (1ce689a, Koordinator-geprueft). Task 5: complete.
Task 6: implementiert 3f3ce8e (1935 Tests; gespeicherte Saetze nicht geklemmt, als 'nicht mehr zulaessig' angezeigt). Review dispatcht. Task 7 dispatcht (letzter Task, kein eigenes Review).
Task 6: complete (Approved, 3f3ce8e). Minor fuer Fix-Welle: veralteter '19 | 7 | 0'-Kommentar in src/lib/tax.ts:23; NewProductDialog Default-Satz ueber dieselbe Funktion wie emptyLine.
Task 7: complete (f88fc4d, 71a9aff; Gate 7/7 gruen, 1935 Tests, PG gruen, Smoke 18/18). Bug fuer Fix-Welle: MarkeForm upload/removeFile setValues(j.settings) verwirft ungespeicherte Eingaben. Abschluss-Review (opus) dispatcht.
Abschluss-Review (opus): Needs fix wave — C1 icon-Route Fallback favicon.ico fehlt im Docker-Runner (500 auf jeder Seite ohne Upload); I1 MarkeForm verwirft ungespeicherte Eingaben bei Upload; I2 ProductForm/NewRecurringForm/PartialCreditForm fest 19/7/0 + opake Fehler (500 bei credit-Route); 9 Minor. Fix-Welle dispatcht.
Fix-Welle: a33d443 (C1+Dockerfile), 17c869c (I1+I2), 0b60e16 (M1–M7,M9), da543fe (Symbol-Export aus use-server-Datei, nur im Dev-Server sichtbar); 1941 Tests, Smoke 8/8. M8 (Rate-Limit Asset-Routen) Backlog. Scoped Re-Review dispatcht.
Fix-Welle Re-Review: alle Befunde adressiert; NEU Important: MCP-Tools (products/recurring/invoices) fangen TaxRateNotAllowedError nicht -> failUnknown. Fix-Runde 2 dispatcht.
Fix-Runde 2: c29ef91 (MCP-Tools fangen TaxRateNotAllowedError, 3 Tests; Koordinator-geprueft). Merge nach main.

## Offen / Backlog
- M8: oeffentliche Asset-Routen ohne Rate-Limit (zwei DB-Abfragen je Anfrage) — Reverse-Proxy-Thema.
- Dev-Server-only-Fehler (Symbol-Export aus use-server-Datei) wird vom Build nicht erkannt — Smoke bleibt Pflicht.
