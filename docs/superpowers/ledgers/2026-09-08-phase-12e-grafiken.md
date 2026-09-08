# Ledger Phase 12e — Grafiken

Branch `phase-12e/grafiken` aus Fork-main 6aac406, Plan `docs/superpowers/plans/2026-09-08-phase-12e-grafiken.md`, Spec Paket F. Modelle: sonnet/opus. Ergebnis: 2045+ Tests gruen, Gate komplett gruen, Smoke 33/33 + Fix-Smoke 14/14, Screenshots 1440/400 px gesichtet.

## Commits
- cd39a96 feat(reporting): Statusverteilung und Zahlungsverhalten als reine Funktionen (Phase 12e, Task 3)
- 9da42fb feat(reporting): Umsatz je Monat und Top-Kunden als reine Aggregationsfunktionen (Phase 12e, Task 2)
- 0f7a939 feat(charts): Inline-SVG-Baukasten Bar/Line/Donut ohne neue Abhaengigkeit (Phase 12e, Task 1)
- 926f7e7 feat(dashboard): Umsatzreihe, Statusring und Top-5-Kunden auf Uebersicht und Kundenseite (Phase 12e, Task 4)
- aafe39e fix(reporting): Gutschriften vorzeichenrichtig, stornierte Originale periodengerecht (12e Task 2 Fix 1)
- d64ffe0 fix(charts): negative Balken im Zeichenbereich, Kontrast der Achsen, svg-title/desc, Verhaltens-Tests (12e Task 1 Fix 1)
- 7002f30 fix(charts,reporting): roundHalfUp aus money.ts, Label-Breite der Balkenbeschriftung
- ccafbc7 feat(reporting): GET /api/v1/Report, MCP get_report und Doku (Phase 12e, Task 5)
- 9178906 fix(reporting,charts): I1-I4 Fix-Welle Phase 12e — LineChart-Domainskala, Vorzeichen-Normalisierung, einheitliche Nettoumsatz-Definition
- 9616edc fix(charts,mcp,docs): I5-I6 Fix-Welle Phase 12e — Layout/Achsen/Skalierung, MCP-Konsistenz, Minor-Befunde
- 70c7c6a fix(report): unpassende Parameter je kind mit 400 abgelehnt (12e Fix 2)

## Verlauf, Befunde, Rulings (SDD-Ledger)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 (src/components/charts/*) vs T2 (domain/reporting revenue, customers) vs T3 (domain/reporting status, payment-behaviour) | disjunkt, keine Schemaaenderung | parallel |
| T4 (dashboard + kunden/[id] verdrahten) | konsumiert T1–T3 | nach T1–T3 |
| T5 (reporting/query.ts, GET /api/v1/Report, MCP get_report, Doku, Smoke) | letzter, kein eigenes Review | nach T4 |
| Planer-Rulings: LineChart auf Kundenseite; monthlyRevenue ueber netShareCents; paymentBehaviour ohne openCents (customerOverview) | — | ok |
Reihenfolge: (T1 ∥ T2 ∥ T3) -> T4 -> T5. Modelle: sonnet/opus.
T1 ∥ T2 ∥ T3 dispatcht. BASE 6aac406.
Task 3: implementiert cd39a96. Review dispatcht.
Task 2: implementiert 9da42fb (Test-Erwartung topCustomers korrigiert). Review dispatcht.
Task 3: complete (Approved, cd39a96). Fuer Task 5: roundHalfUp aus src/lib/money.ts importieren statt lokal.
Task 1: implementiert 0f7a939 (volle Suite nur wegen paralleler Laeufe auf test.db flaky). Review dispatcht. Task 4 dispatcht (BASE HEAD).
Task 2: review — Critical: sign-Flip fuer CREDIT_NOTE doppelt (netTotalCents bereits negativ) -> Gutschriften erhoehen Umsatz; Important: stornierte Originale (CANCELLED) fallen aus dem Fenster, Storno-Gutschrift bleibt -> kein Netto-Null; Minor: topCustomers limit ohne Bounds (Zod in Task 5).
Ruling: kein Vorzeichen-Flip (Betraege sind vorzeichenrichtig gespeichert, wie dashboardSummary); CANCELLED-Originale bleiben im Umsatz (nur DRAFT ausgeschlossen), sodass Original (+X, Monat A) und Storno (-X, Monat B) sich periodengerecht aufheben; in ARCHITEKTUR dokumentieren. Fix-Runde 1/5 an Task-2-Implementer.
Task 1: review — Important: BarChart negative Werte ueberlaufen den viewBox (vertikal+horizontal); Achsentext #94a3b8 unter WCAG AA; Minor: svg <title>/<desc>, Donut-Legende doppelt fuer SR, Tests nur NaN-Checks. Fix-Runde 1/5 an Task-1-Implementer (nur src/components/charts/* + charts.test.tsx).
CI main 6aac406 (12d): alle 4 Jobs gruen.
Task 4: implementiert 926f7e7 (4 Karten; Monatslabel ohne Punkt). Review dispatcht. Task 5 wartet auf Fix-Runden T1/T2.
Task 2: fix round 1/5 (aafe39e, Koordinator-geprueft). Task 2: complete.
Task 4: complete (Approved, 926f7e7). Fuer Task 5: truncateName 24 -> labelWidth 110 zu klein (BarChart horizontal) — labelWidth im Kit auf ~150 oder Kuerzung ~18 Zeichen, Test.
Task 1: fix round 1/5 (d64ffe0, Koordinator-geprueft). Task 1: complete. Task 5 dispatcht (letzter Task, kein eigenes Review; inkl. Nachtraege roundHalfUp-Import, labelWidth/truncateName).
Task 5: complete (7002f30, ccafbc7; Gate gruen 2023 Tests, Smoke 33/33 echte Checks). Beobachtungen fuer Fix-Welle: Leerzustand bei Null-Umsatz (monthlyRevenue immer 12 Nullen), 'Letzte Belege' Umbruch bei 400px. Abschluss-Review (opus) dispatcht.
Deploy-Vorpruefung: Server 9420a20, 27 Migrationen, Platte 82 % -> image prune vor Build.
Abschluss-Review (opus): Needs fix wave — 0 Critical, 6 Important (I1 LineChart negative Werte ausserhalb viewBox; I2 manuell angelegte Gutschrift mit positiven Betraegen erhoeht Umsatz; I3 Kacheln vs Diagramm brutto/netto und CANCELLED-Handling widerspruechlich; I4 ANLEITUNG widerspricht Code; I5 Dashboard-Raster streckt Karten, Donut zu gross, keine y-Achse; I6 Schriftgroessen in viewBox-Einheiten unlesbar), 13 Minor.
Rulings: I2 -Math.abs(share) fuer CREDIT_NOTE; I3 Kacheln und Diagramme rechnen identisch (netto, accrual, nur DRAFT ausgeschlossen) und sind als "Nettoumsatz" beschriftet, Aging = offen brutto, Donut = Anzahl (Beschriftung); I5 grid items-start, Donut max ~220 px, y-Achse mit 3–4 Ticks im BarChart; I6 ChartFrame bekommt viewBoxWidth (Karten 320, volle Breite 640) mit Schrift 12 viewBox-Einheiten + min. Kartenhoehe; Screenshots 1440/400 px im Fix-Smoke.
Fix-Welle: 9178906 (I1–I4), 9616edc (I5–I6, Minors, Doku; duale SVG-Varianten hidden/sm:hidden); 2045 Tests, Smoke 14/14. M8 offen -> Ruling: unpassende Report-Parameter mit 400 ablehnen (superRefine) — in Re-Review-Runde. Scoped Re-Review dispatcht.
Fix-Welle Re-Review: Clean (M5 statusCounts findMany unbounded -> Backlog; M8 in Fix 2).
Fix 2: 70c7c6a (M8 superRefine, Koordinator-geprueft, 16/16). Merge nach main.

## Offen / Backlog
- M5: statusCounts laedt alle Rechnungen der Org (ungebunden) — bei grossen Bestaenden auf Aggregat-Query umstellen.
- Umsatz-Diagramm doppelt gerendert (hidden/sm:hidden) wegen SVG-Schriftskalierung.
- Reporting ist betrieblich (Netto, periodengerecht), keine EUeR/FiBu (LIMITATIONEN).
