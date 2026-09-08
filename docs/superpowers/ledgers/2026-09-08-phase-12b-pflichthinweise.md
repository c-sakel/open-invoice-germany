# Ledger Phase 12b — Pflichthinweise und E-Rechnung

Branch `phase-12b/pflichthinweise` aus Fork-main b11f6e9, Plan `docs/superpowers/plans/2026-09-08-phase-12b-pflichthinweise.md`, Spec Paket B. Modelle: sonnet/opus. Ergebnis: 1894 Tests gruen, validate:erechnung 39/39 (20 Fixtures), Gate komplett gruen, Smoke 13/14 (Bug behoben).

## Commits
- ae4e2af feat(erechnung): BT-121 (VATEX) ergaenzt, BT-120 aus einer Quelle statt Dublette (Phase 12b, Task 3)
- 51059c4 feat(steuer): Schema AUSFUHR, Kategorie O, Differenzbesteuerung als E (BR-S-05), Pflichthinweistexte mit Quelle (Phase 12b, Task 1)
- 38343b9 feat(pflichtangaben): exakte Hinweispruefung statt Erst-Wort-Heuristik, Blocker fuer IG/RC/Ausfuhr (Phase 12b, Task 2)
- 7f15a0e feat(erechnung): BG-14 Rechnungszeitraum und BT-80 Lieferland in UBL und CII (Phase 12b, Task 4)
- 7e61176 feat(rechnung): § 14b-Aufbewahrungshinweis verdrahtet, Storno-/Korrekturtitel, alle sieben Steuerschemata in der UI (Phase 12b, Task 5)
- 76b9c29 fix(editor): Pflichthinweis nur einmal voranstellen, Roundtrip-Test consumerRetentionHint (12b Task 5 Fix 1)
- e60bdb0 test(erechnung): fuenf KoSIT-Fixtures fuer AE/K/G/E, BR-CO-26-Fix, Compliance/Anleitung nachgefuehrt (Phase 12b, Task 6)
- 09d57e4 fix(rechnung): Korrekturbelege von den Phase-12b-Pflichtangaben-Blockern ausnehmen (C1, Fix-Welle Final-Review Phase 12b)
- 4fe69e0 fix(erechnung): I1-I3 aus dem Abschluss-Review korrigiert, Detailseiten-Titel der Storno-Gutschrift gefixt (Fix-Welle Final-Review Phase 12b)
- bdd6a5b fix(rechnung): Minor-Befunde M2/M4/M5/M6/M9/M11 aus dem Abschluss-Review (Fix-Welle Final-Review Phase 12b)
- 3f8f8f9 fix(ui): Typbezeichnungen Rechnungskorrektur/Stornorechnung vereinheitlicht (12b Nachtrag)

## Verlauf, Befunde, Rulings (SDD-Ledger)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 (schemas, tax.ts, mandatory.ts:51-58 SCHEME_NOTICE, Migrationen, PG-Fall 17) -> T2 (mandatory.ts Rest) | beide mandatory.ts | sequentiell T1 vor T2 |
| T3 (exemption.ts, xrechnung.ts:56-69/290-296, cii.ts:42-57/260-268) <-> T4 (types, mapper, xrechnung.ts:195-226, cii.ts:228-238/255-270) | beide xrechnung.ts/cii.ts | sequentiell T3 vor T4 |
| T1 vs T3 | disjunkt (schemas/tax/mandatory vs einvoice) | parallel ok |
| T2 vs T4 | disjunkt (mandatory vs einvoice) | parallel ok |
| T5 (invoiceHeaderFields, create/update, einvoice/*, pdf, UI, MCP/API) | konsumiert T1–T4 | nach T4 |
| T6 Fixtures/COMPLIANCE/Doku/Gate | letzter, kein eigenes Review | nach T5 |
| Plan-Rulings uebernommen: BT-80-XPath korrigiert; CII-Reihenfolgen XSD-fatal; RecurringInvoice ohne DRAFT -> alle DIFFERENZ-Abos migriert; Pflichthinweis per Knopf statt Auto-Overwrite | — | ok |
Reihenfolge: (T1 ∥ T3) -> (T2 ∥ T4) -> T5 -> T6. Modelle: Implementer/Reviews sonnet, Abschluss opus.
T1 + T3 parallel dispatcht. BASE b11f6e9.
Task 3: implementiert ae4e2af (CII-Test-Assertion auf Header-Index umgestellt). Review dispatcht. Task 4 dispatcht (BASE ae4e2af).
Task 1: implementiert 51059c4 (openapi.json regeneriert; Fall-9-Regex nicht noetig). Review dispatcht. Task 2 dispatcht (BASE 51059c4).
CI main b11f6e9 (12a): alle 4 Jobs gruen (inkl. postgres-migrations Fall 16).
Task 1: complete (Approved, 51059c4). Minor fuer Task 5: convert.ts:230 taxCategory-Cast um 'O' ergaenzen (besser: TaxCategory-Typ importieren).
Task 3: complete (Approved, ae4e2af).
Task 2: implementiert 38343b9 (Bestandstest Reverse Charge mit vatId). Review dispatcht.
Task 2: complete (Approved, 38343b9). Minor fuer Task 6-Tests: Negativfall Nicht-EU-Praefix bei IG_LIEFERUNG.
Task 4: implementiert 7f15a0e (BT-80 mit CityName/PostalZone wegen BR-DE-10/11; Test-Regex whitespace-tolerant). Review dispatcht. Task 5 dispatcht (BASE 7f15a0e).
Task 4: complete (Approved, 7f15a0e). BT-80 aus Rechnungsanschrift, Lieferanschrift nicht im XML -> LIMITATIONEN (Task 6). Backlog: load.ts shippingAddress laden und fuer BT-80 nutzen.
Task 5: implementiert 7e61176 (Edit-Roundtrip + MCP update_invoice_draft ergaenzt; convert.ts-Cast; COMPLIANCE §11 deckt Titel bereits). Review dispatcht. Task 6 dispatcht (letzter Task, kein eigenes Review).
Planer (opus) fuer 12c/12d/12e dispatcht (parallel zu Task 5 Review + Task 6).
Task 5: review — Critical: toInvoicePayload stellt SCHEME_NOTICE bei jedem Speichern erneut voran (Duplikat in notes); Important: kein Roundtrip-Test fuer consumerRetentionHint. Fix-Runde 1/5 an den Task-5-Implementer (draft.ts + editor-draft.test.ts, disjunkt zu Task 6).
Task 5: fix round 1/5 (76b9c29, Koordinator-geprueft). Task 5: complete.
Task 6: complete (e60bdb0; Gate gruen 1882 Tests, 39/39 Fixtures; BT-29-Fallback fuer BR-CO-26 in xrechnung/cii). Abschluss-Review (opus) dispatcht.
Smoke 12b: 13/14, 0 Konsolenfehler. Bug fuer Fix-Welle: TYPE_TITLE in rechnungen/[id]/_parts/invoice-view-model.ts:33 (und Listen-TYPE_LABEL?) noch 'Gutschrift / Storno' -> 'Stornorechnung'.
Abschluss-Review (opus): Needs fix wave — C1 Blocker laufen auch im Storno-/Gutschriftpfad (Alt-Rechnungen RC/IG/KU nicht stornierbar); I1 RC-Blocker verlangt USt-IdNr, BR-AE-02 akzeptiert auch Steuernummer (BT-47); I2 CII ohne BT-77/78 -> XRechnung-CII ungueltig (BR-DE-10/11); I3 COMPLIANCE §8/Sample-Skript nennen nicht existierende BR-G-3; 11 Minor. Datei .superpowers/sdd/plan-12b/final-review.md.
Rulings: Korrekturbelege (Storno/Gutschrift/Teilgutschrift) von den neuen Schema-Blockern ausnehmen (Original ist bereits GoBD-geprueft), Tests je Schema; RC-Blocker: USt-IdNr ODER Steuernummer des Kunden (BR-AE-02), Quelle korrigieren; CII bekommt BT-77/78 wie UBL; COMPLIANCE/Sample auf BR-G-02/03 (Verkaeufer) korrigieren und AUSFUHR ohne Verkaeufer-USt-IdNr in LIMITATIONEN; Titel 'Stornorechnung' auch auf Detailseite + Listenlabel.
Fix-Welle: 09d57e4 (C1+Tests), 4fe69e0 (I1–I3 Doku/CII, Titel), bdd6a5b (Minors); 1894 Tests, 39/39 Fixtures. Nicht gefixt (dokumentiert): BT-47-Alternative (kein Feld), credit.ts erbt notes nicht. Scoped Re-Review dispatcht.
Fix-Welle Re-Review: Clean. Koordinator-Nachtrag 3f8f8f9 (Labels). Merge nach main.

## Offen / Backlog
- BT-47 (Legal Registration Id des Kunden) fehlt im Datenmodell; RC-Blocker verlangt USt-IdNr (LIMITATIONEN).
- credit.ts erbt notes/Pflichthinweis des Originals nicht (kosmetisch, LIMITATIONEN).
- Lieferanschrift im XML (BT-77/78/80) immer aus Rechnungsanschrift; load.ts shippingAddress laden (Backlog).
- doc-type-labels.ts (Mail-Betreff) sagt weiterhin 'Gutschrift'.
