# SDD ledger — plan: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-03-phase-4b-editor.md
Branch phase-4b/editor aus main 223a0ad. Spec: docs/superpowers/specs/2026-09-03-phase-4-rechnungskomfort-design.md (4b).

## Pre-flight-Scan
| Paar/Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1→T3/T5 | lineType/descriptionLong/articleNumber, Kopffelder, DocumentAttachment, Zod | konsistent; Nicht-ITEM-Zeilen: Betraege 0 erzwungen |
| T2→T4/T5 | richtext parse/html/pdf/plain — pure, Client-Import fuer Vorschau | Regel: kein HTML gespeichert |
| T3 update | updateDraftInvoice neu (Bestand: kein Invoice-Edit) — Pricing-Modul (4a) wiederverwenden | Ruling: Muster updateDraftDocument |
| T3 storage | ATTACHMENTS_DIR ausserhalb Web-Root; Docker-Volume (Task 6) | Betrieb: Volume + Backup |
| T4 XML | nur ITEMs ins XML; BT-154 Klartext; BT-155; BT-13 | Validator-Gate, Fixture in T4 |
| T5 UI | NewInvoiceForm/NewDocumentForm erweitern; Drag&Drop nativ; kein neues Paket | Regel |
| T6 | Tabellenzahl 29 | in Brief |

Task 1: dispatched (sonnet), BASE 223a0ad
Task 1: implementer DONE (2a62c7e), 419/419; PG-Skript nicht komplett gelaufen (Task 6). Task 1: task reviewer dispatched (sonnet), diff 223a0ad..2a62c7e
Task 2: dispatched (sonnet) parallel zum Task-1-Review — Ruling: Task 2 ist ein reines neues Modul (src/lib/richtext), keine Dateiueberschneidung mit Task 1; BASE 2a62c7e
Task 1: reviewer APPROVED (Mittel: productSchema ohne articleNumber; Wichtig fuer T3: Domain reicht lineType/descriptionLong/articleNumber und
  Invoice-Kopffelder noch nicht durch → HEADING wuerde als ITEM mit Menge 0 landen). Ruling: beides in Task 3 (Domain) statt Task 4/5.
Task 1: complete
Task 2: implementer DONE (fa0d490), 433/433. Task 2: task reviewer dispatched (sonnet), diff 2a62c7e..fa0d490
Task 3: dispatched (sonnet) parallel zum Task-2-Review (keine Dateiueberschneidung), BASE fa0d490, mit task-3-addendum.md + task-3-facts.md
Task 2: reviewer APPROVED (Low: Apostroph nicht escaped; Rand-Payload-Tests fehlen) — Ruling: Mini-Commit in Task 4.
Task 2: complete
Task 3: implementer DONE (80df7b7, cd7796b, e1086ab; Agent nach Netzfehler fortgesetzt), 487/487. Bedenken: duplicate ohne lineType; updateDraftInvoice erlaubt type-Wechsel → Auflagen. Task 3: task reviewer dispatched (sonnet), diff fa0d490..e1086ab
Task 4: dispatched (sonnet) parallel zum Task-3-Review (Mapper/XML/PDF/richtext-html — keine Ueberschneidung mit Task-3-Dateien), BASE e1086ab, mit task-4-addendum.md + task-4-facts.md
Task 3: review — NICHT freigegeben: Schwer: updateInvoiceSchema erlaubt type-Wechsel; Mittel: duplicateQuote/duplicateDeliveryNote ohne lineType und
  ohne ITEM-Filter (Menge-0-Workaround); Nit: MAX_ATTACHMENT_SIZE_BYTES doppelt. Ruling: Fix-Runde 1 nach Abschluss von Task 4 (gleicher Arbeitsbaum).
Task 4: implementer DONE (8ad9abc, df02156), 508/508, Validator alle Fixtures. Task 4: task reviewer dispatched (sonnet), diff e1086ab..df02156
Task 3: fix round 1 (resume implementer), BASE df02156 — parallel zum Task-4-Review (disjunkte Dateien)
Task 4: reviewer APPROVED (Minor: BR-16 zaehlt alle Zeilen statt ITEM — Einzeiler in Task 5).
Task 4: complete
Task 3: fix round 1 DONE (4cb8cc2), 510/510; Koordinator-Verifikation OK.
Task 3: complete
Task 5: dispatched (sonnet), BASE 4cb8cc2, mit task-5-addendum.md + task-5-facts.md
Task 5: implementer DONE (d1e24ba, 4cc18ac, 1700528), 511/511; Bedenken: dokumente-Editor nicht klickgetestet; SMTP nicht e2e. Task 5: task reviewer dispatched (sonnet), diff 4cb8cc2..1700528
Task 6: dispatched (sonnet) parallel (Doku/Compose/PG-Skript — disjunkt), BASE 1700528, kein eigenes Review
Task 5: review — NICHT freigegeben: Blocker: Kundenwechsel im Editor behaelt contactPersonId/billingAddressId/shippingAddressId; Server prueft nur orgId,
  nicht customerId (Snapshot-Verunreinigung) — gleiches Muster vermutlich in NewDocumentForm/document create+update (3a); Mittel: keine Routen-/MCP-Tests
  fuer PATCH invoices, attachments POST/GET/DELETE, 4 MCP-Tools; Low: Teil-Erfolg beim Mehrfach-Upload ohne Rueckmeldung.
  Ruling: Fix-Runde 1 (nach Task 6, gleicher Arbeitsbaum): Client-Reset + serverseitige customerId-Pruefung in invoice create/update UND document
  create/update; Routen-/MCP-Tests; Upload-Antwort mit Liste gespeicherter Dateien.
Task 6: implementer DONE (8ceff6d, ac0de34), 511/511, PG 6/6, 29 Tabellen; Betrieb: backup.sh um oig-attachments erweitern.
Task 6: complete (kein eigenes Review; Abschluss-Review prueft)
Task 5: fix round 1 (resume implementer), BASE ac0de34
Task 5: fix round 1 DONE (afaa485, 64cd8de), 536/536. Ruling: kein separates Re-Review — Whole-Branch-Review prueft die Fix-Runde zuerst.
Task 5: complete
Final: whole-branch review dispatched (opus), package review-223a0ad..64cd8de.diff
Final: review (opus) — Kritisch K1 cancel.ts/credit.ts ohne lineType (Menge-0-ITEMs im XML, BR-S-05/08), K2 Client-Reset verpufft (undefined im JSON),
  Server mappt nicht auf null; Wichtig W1 Download 500 bei Unicode-Dateinamen, W2 HTML-Ansichten (inkl. oeffentlich) rendern Bloecke flach, W3 Lieferschein-
  Restmengen mit Nicht-ITEM; Gering G1-G7; Hinweise. Merge: nicht bereit.
Final: Ruling: EINE Fix-Welle: K1, K2, W1, W2, W3, G1 (pdf-data ITEM), G2 (MCP base64-Vorpruefung), G3 (Mail-Gesamtlimit inkl. Beleganhaenge), G4 (Dedup-Race
  → P2002 idempotent), G5 (nosniff), G6 (filename-Sanitizing im Schema), G7 (Doku: Artikelnummer-Satz, kein Drag-and-Drop-Upload, Anhaenge an
  festgeschriebenen Rechnungen erlaubt, Abos ohne Bloecke). Kosten: eine Re-Review-Runde.
Final: fix dispatched (sonnet, frisch), BASE 64cd8de
Final: fix DONE (becb8c7, 6def362, 9ca46a9, a99ceec), 553/553, 21 Fixtures; Bonus-Fund finalize.ts/mandatory.ts. Final: scoped re-review dispatched (sonnet), diff 64cd8de..a99ceec
Final: re-review APPROVED (alle Punkte). Merge phase-4b/editor -> main (ff).
