# SDD ledger — plan: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-03-phase-3a-dokumente.md
Branch phase-3a/documents aus main 335087a. Spec: docs/superpowers/specs/2026-09-03-phase-3-dokumente-design.md (specs). Plan 3a von zwei.

## Pre-flight-Scan
| Paar/Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1→T3 | TextTemplate Unique (orgId,docType,position,name) wird von ensureOrgTextTemplates gebraucht | Plan nennt es erst in T3 — Ruling: in T1-Brief aufgenommen (Migration additiv) |
| T1→T2 | QuoteStatus/DeliveryNoteStatus/SnapshotSource SENT | konsistent |
| T2→T3 | setQuoteStatus wird von convertDocument (ACCEPTED bei AB-Erzeugung) genutzt | konsistent; Ruling: Angebot wird bei AB-Erzeugung ACCEPTED |
| T3 convert | convertDocumentToInvoice setzte Quote auf CONVERTED — T1-Backfill macht CONVERTED→ACCEPTED; T3 stellt den Setter um | Reihenfolge stimmt; Ruling: Quote bleibt nach Rechnungserzeugung im Status, billingState kommt aus Relation |
| T4 XML | Kopf-/Fusstext nicht ins XML | Ruling festgehalten; validate:erechnung bleibt Gate |
| T5 Route convert | bestehende POST /convert ohne Body muss kompatibel bleiben | Brief nennt es |
| T6 Tabellenzahl | 3a legt keine Tabelle an → 26 | in Brief |

Task 1: dispatched (sonnet), BASE 335087a
Task 1: implementer DONE (8add06a), 153/153; Bedenken: CONVERTED-Setter bleibt bis T3/T5 (geplant); PG-Wrapper wieder per expect. Task 1: task reviewer dispatched (sonnet), diff 335087a..8add06a
Task 1: reviewer APPROVED (Info: CONVERTED-Setter bis T3).
Task 1: complete
Task 2: dispatched (sonnet), BASE 8add06a, mit task-2-addendum.md
Task 2: implementer DONE (7f8f7f1), 176/176; Bedenken createBusinessDocument persistiert contactPersonId nicht → im T3-Nachtrag abgedeckt. Task 2: task reviewer dispatched (sonnet), diff 8add06a..7f8f7f1
Task 2: reviewer APPROVED. Low: ohne select; RECURRING-Knoten ungetestet. Mittel (Cross-Task): createBusinessDocument friert Snapshot
  bei CREATE ein → SENT-Freeze greift praktisch nie. Ruling: Entwurf ist kein ausgestellter Beleg — beim Uebergang nach SENT wird ein
  Snapshot mit snapshotSource CREATE durch den SENT-Snapshot (Ansprechpartner/Rechnungsadresse) ERSETZT; FINALIZE/SENT/MIGRATION/INHERITED
  bleiben unantastbar. createBusinessDocument persistiert contactPersonId/billingAddressId und baut den CREATE-Snapshot bereits mit
  Ansprechpartner/Adresse. Beides in Task 3. Kosten falls falsch: eine Runde.
Task 2: complete
Task 3: dispatched (sonnet), BASE 7f8f7f1, mit task-3-addendum.md + Cross-Task-Auflage
Task 3: implementer DONE (c44be39, 6641959), 202/202. Task 3: task reviewer dispatched (sonnet), diff 7f8f7f1..6641959
Task 3: review — Spec OK; NICHT freigegeben: F1 Konvertierung/Duplizieren nicht in einer Tx (Lastenheft 50), F2 LS-Duplikat (DRAFT)
  zaehlt in remainingQuantities, F3 Rechnungs-Duplikat ohne Kopf-/Fusstext/Daten, F4 NUL-Bytes in ensure.ts, Info notes bei AB.
  Ruling F2: remainingQuantities zaehlt nur CREATED/SENT/DELIVERED (sourceLineId bleibt im Duplikat, damit es nach CREATED zaehlt).
Task 3: fix round 1 (resume implementer), BASE 6641959
Task 3: fix round 1 DONE (dc2f027), 208/208. Task 3: scoped re-review dispatched (sonnet), diff 6641959..dc2f027
Task 3: re-review APPROVED (5/5).
Task 3: complete
Task 4: dispatched (sonnet), BASE dc2f027, mit task-4-addendum.md
Task 4: implementer DONE (5118c77), 222/222. Task 4: task reviewer dispatched (sonnet), diff dc2f027..5118c77
Task 4: reviewer APPROVED (2 Low: buyer.email im DB-freien Kontext, ACCEPTED-bleibt-Test) — Ruling: Mini-Commit in Task 5.
Task 4: complete
Task 5: dispatched (sonnet), BASE 5118c77, mit task-5-addendum.md
Task 5: implementer DONE (d28fb3f, 17adb40, f0c43e1), 224/224, Klickpfad ok, Formular-Bug mitbehoben. Task 5: task reviewer dispatched (sonnet), diff 5118c77..f0c43e1
Task 5: review — NICHT freigegeben: Hoch: kein Aufrufer fuer DRAFT→CREATED (Schema-Enum, Route, UI, MCP fehlen); Mittel: lokale
  bodySchemas statt convertDocumentSchema; Low: PATCH 400 statt 500, Regex-404, Duplikat verliert sourceType/sourceId.
  Ruling: Fix-Runde 1 = Hoch + Mittel + sourceType/sourceId + NotFoundError-Klasse statt Regex; PATCH-Code mit.
Task 5: fix round 1 (resume implementer), BASE f0c43e1
Task 5: fix round 1 DONE (9a4d81b), 228/228. Task 5: scoped re-review dispatched (sonnet), diff f0c43e1..9a4d81b
Task 5: re-review APPROVED (5/5).
Task 5: complete
Task 6: dispatched (sonnet), BASE 9a4d81b, mit task-6-addendum.md
Task 6: implementer DONE (86cfd68, fcfd408), 228/228, PG 6/6. Bedenken: docs/MCP.md ohne neue Tools → Fix-Welle.
Task 6: Ruling: kein separates Task-Review (Test+Doku) — Whole-Branch-Review prueft Task 6 als ersten Punkt. Kosten: keine.
Task 6: complete
Final: whole-branch review dispatched (opus), package review-335087a..fcfd408.diff
Final: review (opus) — Kritisch 0; Wichtig W1 Restmengenpruefung ausserhalb Tx (Race), W2 Konvertierung ohne Statuspruefung,
  W3 Entwurfsbearbeitung erneuert CREATE-Snapshot nicht, W4 EXPIRED persistierbar (Doku sagt nein), W5 keine Routen-/Action-Tests,
  W6 MCP.md ohne neue Tools; Gering G1-G12; Task-6-Fall-6 unvollstaendig (q1 nicht geprueft, kein Nicht-CONVERTED-Fixture).
Final: Ruling: EINE Fix-Welle: W1-W4, W6, G1-G10, Task-6-Ergaenzung (q3 SENT + q1), W5 teilweise (text-template-action-Test +
  Statusrouten-Mapping-Test); G11 (Seitenumbruch), G12 (Restmengen ueber Belegketten) Backlog. Kosten: eine Re-Review-Runde.
Final: fix dispatched (sonnet, frisch), BASE fcfd408
Final: fix DONE (4f554a4, 6bd26ee, ae30eb7, 2fa6c9e), 253/253, PG 6/6. Final: scoped re-review dispatched (sonnet), diff fcfd408..2fa6c9e
Final: re-review — 1 Rest: convertDocumentToInvoice prueft Status nicht fuer PROFORMA. Fix round 2 (resume), BASE 2fa6c9e. Ruling: Einzeiler + Test, Verifikation durch Koordinator im Diff statt drittem Review-Seat.
Final: fix round 2 DONE (a70b532), 255/255; Koordinator-Verifikation OK. Merge phase-3a/documents -> main (ff).
