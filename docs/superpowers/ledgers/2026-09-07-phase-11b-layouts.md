# Ledger Phase 11b — PDF-Layouts, automatische Fußzeile, Briefpapier-Seite

Branch `phase-11b/layouts` aus Fork-main 151acc5, Plan `docs/superpowers/plans/2026-09-07-phase-11b-layouts.md`, Spec `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md`.
Modelle: Implementer/Task-Reviews/Re-Reviews sonnet, Abschluss-Review opus. Ergebnis: 19 Commits, 1780 Tests gruen (TZ=UTC), Build/Lint/Typecheck/validate:erechnung/api:check gruen.

## Commits
- c345182 feat(layouts): Schema, Migrationen, Zod und Aufloesung fuer PDF-Layouts (Phase 11b, Task 1)
- b8431b0 feat(layouts): Layout-Engine, standard-Layout extrahiert, Rechnungs-Renderer auf Hooks (Phase 11b, Task 2)
- d383bb7 feat(layouts): automatische Fusszeile, Theme-Fakten, Lieferschein/Mahnung auf Layout-Hooks (Phase 11b, Task 3)
- d415425 feat(layouts): Layouts schlicht, klassik, modern mit Miniaturen (Phase 11b, Task 4)
- 01ab8f0 fix(layouts): footerMode strikt + Backfill, Lieferschein-Paginierung, Fusszeilen-Test (Tasks 2+3 Fix 1)
- 13be796 feat(layouts): blau, schwarz, kompakt; Layout-Matrix-Tests (Phase 11b, Task 5)
- 24d78f7 fix(layouts): Empfaengerblock-Breite, IBAN-Umbruch in der Fusszeile
- 7132e2b fix(layouts): Fusszeilenhoehe in der Paginierung reserviert, Guards fuer Fusstext und Mahnzeilen (Tasks 2+3 Fix 2)
- ad53feb fix(layouts): Empfaengerbreite fest 240pt, kompakt-Zeilenhoehen in allen Engines (Task 5 Fix 1)
- 6b92a93 feat(layouts): Layout-Aufloesung an allen PDF-Pfaden, Einfrieren beim Festschreiben, Vorschau mit layoutId (Phase 11b, Task 6)
- 4b82b45 feat(layouts): Briefpapier-Seite mit Reitern, Layout-Galerie mit Live-Vorschau, Layout je Beleg (Phase 11b, Task 7)
- a8662ae fix(mcp): Teil-Updates der Einstellungen setzen nicht genannte Felder nicht mehr zurueck
- 3a4f9ea feat(layouts): API v1 Layout, MCP list_pdf_layouts, OpenAPI, Doku (Phase 11b, Task 8)
- 8055ac7 fix(layouts): Schlussblock/Mahntext paginiert, modern-Chrome auf allen Seiten, Summenblock skaliert
- 62a27be fix(layouts): schlicht naeher an der Referenz — GiroCode unter der Summe, Beschriftungen, Kunden-/Ansprechpartnerzeilen
- e813db1 fix(ui): Layout-Galerie — Typ-Zuordnung entfernbar, "Als Standard fuer alle" nicht destruktiv, Speichern robust
- 99acee2 fix(mcp): update_dunning_stage ohne Defaults-Reset; Tests fuer alle Teil-Update-Tools
- 58eca33 feat(api): PATCH print-options fuer Invoice/Quote/DeliveryNote in API v1
- 21b1442 docs(layouts): ARCHITEKTUR-Tabs, LIMITATIONEN (CUSTOM-Fusszeile links ausgerichtet, Repaginierung, Schrift)

## Verlauf, Befunde, Rulings (SDD-Ledger, unveraendert uebernommen)

## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 -> T2/T3/T6/T7/T8 | ids.ts (LAYOUT_IDS, LayoutDocType), Zod layoutId/layoutByType/footerMode, resolveLayoutId/parseLayoutByType/invoiceTypeToLayoutDocType, Branding-Felder, Organization.ownerName | konsistent |
| T2 -> T3/T4/T5 | PdfLayout-Typ (drawKopf/table/drawTotalsRule/drawFooter/footerHeight), shared.ts, standard.ts, registry (Partial bis T5), PdfTheme.layoutId/footerFacts, testPdfTheme-Defaults | konsistent; T4 ergaenzt optional drawPageChrome |
| T2 <-> T3 | footer.ts: T2 darf Vorstufe (CUSTOM/Fallback) anlegen, T3 ergaenzt AUTO — Ruling: T2+T3 an DENSELBEN Implementer, nacheinander | ok |
| T3 -> T6 | loadPdfTheme(orgId, overrideJson?, docType) ; EffectivePrintOptions.layoutId | konsistent |
| T1-Test in pdf-theme.test.ts | it.skip bis T3 (Theme-Felder) | ok, T3 aktiviert |
| T6 <-> finalize | freezePrintOptionsJson(global, existing, layoutId) — Signaturaenderung, einziger Aufrufer finalize.ts | ok |
| T7 -> nav.ts | SETTINGS_ITEMS bekommt key; SettingsTabs abgeleitet (11a-M3) | ok |
| T8 | apiList-Signatur im Kontext nicht verifiziert — Implementer gleicht mit src/api/response.ts ab | Hinweis im Brief |
| Migration | Postgres-Migration handgeschrieben (kein Docker lokal) — Ruling: additive DDL, CI postgres-migrations verifiziert | Kosten bei Irrtum: CI rot, Nachbesserung |
Scan: keine Konflikte. Modelle: Implementer/Task-Reviews sonnet, Abschluss opus. Letzter Task (8) ohne eigenes Task-Review.
Task 1: implementiert c345182 (DONE_WITH_CONCERNS: SQLite-Migration als Tabellen-Rebuild durch Prisma; openapi.json regeneriert; ein Defaults-Test angepasst; ts-expect-error im it.skip bis T3). Ruling: Rebuild akzeptiert (tool-generiert, datenerhaltend), Reviewer prueft SQL.
Task 1: complete (commits 151acc5..c345182, review clean)
Task 1: Ruling (Befund vorbestehend, Important): MCP update_branding_settings (und vermutlich update_print/document/dunning_settings) setzt per `.partial()` + Defaults alle nicht genannten Felder zurueck — wird in Task 8 (MCP-Arbeit) mit dem mergeSentFields-Muster aus /api/v1/Settings behoben + Test; Kosten bei Irrtum: MCP-Aufrufer verlieren Einstellungen (heute schon der Fall).
Task 1: minor (deferred): loadBrandingSettings ohne select (vorbestehend).
Task 2+3: implementiert b8431b0, d383bb7 (Abweichungen: footerMode-Gate praesenzbasiert; S3-Fallback-Assertion umformatiert; Zeilenumbruch in engen AUTO-Spalten moeglich). Review laeuft.
Task 2+3: review — Critical: footerMode nicht beachtet (praesenzbasiert); Important: Lieferschein-Totals nutzen ensureSpace mit Tabellenkopf (ensurePlainSpace fehlt); Important: umformatierter Fallback-Fusszeilen-Test diskriminiert nicht mehr (Absenderzeile erfuellt ihn); Minor: fontSizePt im Lieferschein-Summenblock/Fusszeile hart; docType-Verdrahtung in T6.
Task 2+3: Ruling: striktes footerMode-Gate laut Spec + Backfill-Migration (SQLite+Postgres) `phase11b_footermode_backfill`: UPDATE BrandingSettings SET footerMode='CUSTOM' WHERE footerLeft/Center/Right nicht leer; Alt-Tests setzen footerMode CUSTOM explizit; Fallback-Test prueft fusszeilen-spezifische Strings (Steuer-Nr./IBAN-Gruppierung). Fix-Runde 1 NACH Task 4 (beide beruehren die Engines). Kosten bei Irrtum: Bestandsbetreiber mit Freitext-Fusszeile sehen ohne Backfill die AUTO-Fusszeile.
Task 4: implementiert d415425 (drawPageChrome in allen Engines; lineBreak-Fix in schlicht). Review laeuft. Tasks 2+3: Fix-Runde 1/5 dispatcht (inkl. drawMetaTable-lineBreak-Fix).
Koordinator-Sichtung schlicht/modern-Vorschau: Fusszeile nur auf letzter Seite (Altverhalten; Ruling: Fusszeile auf JEDER Seite, alle Layouts), U+2212 rendert als '"' (Altfehler, Ruling: en dash), GiroCode-Beschriftung beruehrt Fusszeile (Abstand). Als Nachtrag 6-8 in Fix-Runde 1 (Tasks 2+3) gegeben.
Task 4: complete (commits d383bb7..d415425, review clean). drawMetaTable-lineBreak (Important, vorbestehend T2/3) ist Punkt 5 der laufenden Fix-Runde. Minor (deferred): drawIntro-Helfer (Duplikat in 4 Layouts); drawRecipient ohne width (lange Empfaengernamen koennen in Infoblock ragen, vorbestehend) -> Task 5 Implementer: width = infoX - left - 10 in drawRecipient ueber Parameter.
Task 2+3: fix round 1/5 (8 addressed lt. Implementer; commit 01ab8f0). Re-Review dispatcht. Task 5 dispatcht (inkl. drawRecipient-Breite, IBAN-Umbruch in Fusszeile).
Task 2+3: fix round 1/5 (8 addressed, 0 open; NEUE Breakage: Fusszeile je Seite ueberlappt Positionszeilen auf vollen Seiten, weil pageBottom nicht um footerHeight reduziert ist — invoice + delivery-note). Fix-Runde 2 nach Task 5 (Task 5 aendert Zeilenhoehe in invoice-pdf.ts). Out-of-scope notiert: delivery-note footerText ohne Guard; dunning row() ohne Paginierung (vorbestehend) -> beides in Fix-Runde 2 mitnehmen (klein).
Task 5: implementiert 13be796 + 24d78f7. Review dispatcht. Tasks 2+3: Fix-Runde 2/5 dispatcht (pageBottom - footerHeight; Guards Fusstext/Mahnzeilen).
Task 5: review — Important: drawRecipient-Default maxWidth = frame.width-220 passt nicht zum festen Infoblock left+250 in standard/klassik (+blau/schwarz/kompakt) -> Fix: fester Default 240 bzw. explizit in standard/klassik. Minor: HEADING/SUBTOTAL-Zeilenhoehen und Lieferschein/Mahnung-Zeilen skalieren nicht mit base (kompakt); standard-Fusszeile 8pt IBAN kann umbrechen (akzeptiert, Kompatibilitaet). Ruling: Fix-Runde 1 fuer Task 5 NACH Fix-Runde 2 (Tasks 2+3), gleiche Engine-Dateien; Minors 2/3 mitnehmen.
Task 2+3: fix round 2/5 (commit 7132e2b: pageBottom-footerHeight-6, Guards; Test mit 70 Zeilen). Re-Review dispatcht. Task 5: Fix-Runde 1/5 dispatcht (maxWidth 240 fuer standard/klassik; kompakt-Zeilenhoehen HEADING/SUBTOTAL + Lieferschein/Mahnung).
Task 2+3: complete (commits c345182..d383bb7 + 01ab8f0 + 7132e2b, Fix-Runden 1+2 re-reviewt, clean)
Task 5: fix round 1/5 (3 addressed; commit ad53feb, 66 Zeilen). Ruling: vom Koordinator geprueft (Default 240 in shared.ts, explizit in standard/klassik, rowH in allen Engines, HEADING/SUBTOTAL proportional) — kein separates Re-Review; Kosten bei Irrtum: Abschluss-Review.
Task 5: complete (commits 01ab8f0..24d78f7 + ad53feb)
Task 6: implementiert 6b92a93 (settings-consumption-Fixture um layoutId ergaenzt; pdf-theme makeOrg vatId/taxNumber). Review dispatcht. Task 7 dispatcht.
Task 6: complete (commits ad53feb..6b92a93, review clean). minor (deferred): Freeze-Test mit nicht-default vollstaendigem Override ohne layoutId -> Task 8 Implementer ergaenzt eine Zeile.
Task 7: implementiert 4b82b45. Ruling (Implementer, bestaetigt): kein 'dokumente'-Eintrag in SETTINGS_ITEMS, weil /einstellungen/dokumente nur auf /einstellungen/belege umleitet. Review dispatcht. Task 8 dispatcht (letzter Task, kein eigenes Review; enthaelt MCP-mergeSentFields-Fix + Freeze-Testzeile).
Task 7: complete (commits 6b92a93..4b82b45, review clean). ⚠️ Vorschau-iframe im Headless-Screenshot leer (Browser-PDF-Viewer) — im Abschluss-Smoke mit echtem Chrome pruefen. minor (deferred): save() ohne try/catch bei Netzfehler (LayoutGallery + BrandingForm); Fehlerbanner bleibt nach Typwechsel.
Task 8: complete (commits 4b82b45..3a4f9ea; Gate: 1739 Tests, build, validate:erechnung, api:check gruen). Befunde fuer die Fix-Welle: (1) kein REST-v1-Endpunkt fuer Druckoptionen/Layout je Beleg (Spec: API-Paritaet) -> Ruling: PATCH /api/v1/{Invoice,Quote,DeliveryNote}/{id}/print-options ueber setPrintOptions ergaenzen; (2) gleicher Defaults-Reset in src/mcp/tools/dunning.ts update_dunning_stage -> in Fix-Welle beheben.
Abschluss-Review (opus, 151acc5..3a4f9ea): Needs fixes. Important: (1) Rechnungs-Schlussblock (Fusstext/Notizen/Zahlungsbedingungen) + Mahnung "Bitte ueberweisen" ohne ensurePlainSpace -> laeuft in Fusszeile; (2) LayoutGallery "Als Standard fuer alle" loescht layoutByType, kein Weg einen Typ-Eintrag zu entfernen, "Fuer Typ uebernehmen" wirkungslos; (3) dunning.ts update_dunning_stage Defaults-Reset (enabled=true re-aktiviert Stufen!); (4) REST v1 print-options fehlt. Minors + schlicht-Abweichungen zur Referenz (GiroCode links unter Summe, Beschriftungen, Kundennummer/Ansprechpartner-Zeilen, Summenlinie volle Breite).
Ruling Fix-Welle (ein Dispatch): Important 1-4 + Minors (modern-Chrome bei pdfkit-Seiten, Summenblock fontSize base, save try/catch, MCP-Tests fuer alle vier Tools mit Nicht-Default-Werten, Layout-Route Schema, ARCHITEKTUR-Tabs, LIMITATIONEN CUSTOM-Ausrichtung/Repaginierung) + schlicht-Naeherung ueber Layout-Hooks (giroPlacement, labels, Meta-Zeilen Kundennummer/Ansprechpartner). Font (Lato) NICHT jetzt — LIMITATIONEN. Kosten bei Irrtum: eine Re-Review-Runde.
Fix-Welle: 6 Commits 8055ac7..21b1442, Gate 1780 Tests gruen. Befund Implementer: Buyer-Snapshot um customerNumber erweitert (Snapshot-Schicht!) — Re-Review prueft GoBD-Neutralitaet. Re-Review dispatcht.

## Abschluss-Review (opus) und Fix-Welle (6 Commits 8055ac7..21b1442, Re-Review clean)
- Important behoben: Schlussblock/Mahntext paginiert; Galerie nicht-destruktiv (Typ-Zuordnung entfernbar, 'Als Standard fuer alle' nur layoutId); update_dunning_stage ohne Defaults-Reset (partialInputShape zentral + Guard-Test); REST v1 GET/PATCH print-options fuer Invoice/Quote/DeliveryNote.
- schlicht an Referenz angenaehert: giroPlacement below-totals, Beschriftungen (Einzelpreis/Gesamtpreis, Gesamtbetrag netto/brutto, 'zzgl. Umsatzsteuer'), Meta-Zeilen Kundennummer/Ansprechpartner (alle Layouts; EInvoiceParty.customerNumber additiv, Buyer-Snapshot optional, kein XML-Feld).
- Minors: modern-Chrome via pageAdded; Summenblock skaliert mit fontSizePt; save() try/catch; Layout-Route mit layoutSchema; Doku.

## Offen / spaeter
- docs/ANLEITUNG.md §6 veraltet (ein Layout org-weit) -> 11c/11d Doku-Task.
- Schrift: Helvetica statt humanistischer Sans (Referenz Lato); Einbettung einer OFL-Schrift als Asset moeglich (kein npm-Paket) — spaeter.
- Waehrung im PDF '€' statt 'EUR' (formatCents, org-weit).
- CUSTOM-Fusszeile jetzt gleich breite linksbuendige Spalten (vorher links/mitte/rechts); Reprints alter mehrseitiger Rechnungen koennen neu paginieren (Fusszeilenband reserviert) — LIMITATIONEN/COMPLIANCE.
- Mahnung ohne Beleg-Override (nur Typ-/Org-Layout); Organization.ownerName nur per UI (setup_company/MCP ohne Feld, wie website).
- Vorschau-iframe im Headless-Screenshot leer: im echten Browser pruefen (Betreiber-Checkliste).
- loadBrandingSettings ohne select; drawIntro-Helfer; Lieferschein-Summenblock fontSizePt; standard-Fusszeile 8pt IBAN-Umbruch (fitFooterLine mildert).
