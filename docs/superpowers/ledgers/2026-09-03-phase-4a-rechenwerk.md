# SDD ledger — plan: /tmp/claude-501/-Users-christophersakel-PhpstormProjects-PH-invoice/333a4b59-16db-4bc4-8c3d-9b65d3087ff1/scratchpad/plan/2026-09-03-phase-4a-rechenwerk.md
Branch phase-4a/pricing aus main 3807287. Spec: docs/superpowers/specs/2026-09-03-phase-4-rechnungskomfort-design.md (4a).

## Pre-flight-Scan
| Paar/Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1→T2/T3 | computeLineNet, applyDocumentAdjustments, skontoTerms, computeTaxBreakdown(lines, adj) | konsistent; T1 muss Regressionsgleichheit ohne adj beweisen |
| T2 Backfill | Systemcode SKONTO je Org per Migration + Selbstheilung | Muster Phase 1; PG-Fall 6 in T5 auf 9 PaymentMethods |
| T3 XML | AllowanceCharge je Satz, BT-107/108, BT-20-Skonto-Syntax, PaymentMeans aus Snapshot | Validator-Gate; Reihenfolge der UBL-Elemente laut XSD (AllowanceCharge vor TaxTotal; in Zeile vor Item) |
| T4 UI | Live-Summen im Client ueber pricing-Modul (pure, kein Server-Import) | Regel: src/lib/pricing ohne Prisma/DB-Imports |
| Audit K1 | Rabatt nur zusammen mit XML-Mapping | T1-T3 sind Einheit; kein Merge ohne T3 |

Task 1: dispatched (sonnet), BASE 3807287
Task 1: implementer DONE (ccec944), 336/336. Bedenken: Fast-Path total=0 wegen negativer Storno-Buckets. Task 1: task reviewer dispatched (sonnet), diff 3807287..ccec944
Task 1: review — rechnerisch bestaetigt; Hoch: negatives Netto + prozentuale Anpassung wirft an falscher Ebene, inkonsistent zu Festbetrag;
  Low: computeLineNet ohne Guard gegen negative Inputs. Ruling: vorzeichen-invariant — sind ALLE Buckets <= 0 (Storno/Gutschrift), wird auf
  den negierten Buckets gerechnet und das Ergebnis negiert (Storno spiegelt Rabatte des Originals); gemischte Vorzeichen → PricingError;
  computeLineNet verbietet negative Inputs (PricingError). Kosten falls falsch: eine Runde.
Task 1: fix round 1 (resume implementer), BASE ccec944
Task 1: fix round 1 DONE (81e59b6), 345/345. Task 1: scoped re-review dispatched (sonnet), diff ccec944..81e59b6
Task 1: re-review APPROVED (Rechenbelege nachgerechnet).
Task 1: complete
Task 2: dispatched (sonnet), BASE 81e59b6, mit task-2-addendum.md + task-2-addendum-facts.md
Task 2: implementer DONE (bb59b49, 6531135), 362/362. Bedenken: Teilgutschrift erbt Festbetrags-Belegrabatt voll; recordPayment-Rueckgabe geaendert. Task 2: task reviewer dispatched (sonnet), diff 81e59b6..6531135
Task 2: review — Spec OK; Hoch: credit.ts uebernimmt Festbetrags-Belegrabatt/-aufschlag voll auf Teilgutschrift (200 EUR/20 EUR/50 EUR-Teil →
  -30 statt -45) — Folge meines zu generischen Rulings aus Task 1; Low: recordPayment auf PAID erzeugt Ueberzahlung ohne Fehler.
  Ruling (korrigiert): Festbetraege bei Teilgutschrift = round(betrag * creditLineTotal / originalLineTotal); Storno unveraendert voll.
  recordPayment auf PAID → PaymentError. Kosten falls falsch: eine Runde.
Task 2: fix round 1 (resume implementer), BASE 6531135
Task 2: fix round 1 DONE (679df83), 366/366. Task 2: scoped re-review dispatched (sonnet), diff 6531135..679df83
Task 2: re-review APPROVED (Rechenbelege nachgerechnet).
Task 2: complete
Task 3: dispatched (sonnet), BASE 679df83, mit task-3-addendum.md + task-3-addendum-facts.md
Task 3: implementer DONE (b96dad6), 375/375, Validator 11/11. Bedenken: Gutschrift+Belegrabatt nicht im XML; PaymentMeans ohne IBAN jetzt immer. Task 3: task reviewer dispatched (sonnet), diff 679df83..b96dad6
Task 3: review — NICHT freigegeben: A Gutschrift+Belegrabatt: Allowance fehlt (Filter >0), BR-CO-13; B PaymentMeans 58 ohne IBAN (BR-DE-23,
  Regression); C PDF ohne Skonto-Absatz bei leerem paymentTerms. Ruling: A per abs()-Konvention wie Zeilenrabatt; B ohne IBAN und ohne Methode
  → kein PaymentMeans (Altverhalten); C humanPaymentTerms ins EInvoiceData fuer PDF. Fixtures: credit-note-doc-discount, no-iban.
Task 3: fix round 1 (resume implementer), BASE b96dad6
Task 3: fix round 1 DONE (b0fe4dd), 380/380, Validator 13/13; Ruling B korrigiert durch Implementer (BR-DE-1: PaymentMeans Pflicht → Code 1). Koordinator-Verifikation im Diff OK.
Task 3: complete
Task 4: dispatched (sonnet), BASE b0fe4dd, mit task-4-addendum.md + task-4-addendum-facts.md
Task 4: implementer DONE (9c2005b, 5fd14ed), 380/380, Browser-Klickpfad + standalone XRechnung ok; Bedenken: MCP discountPercent in allen lines-Tools, kunden/[id] org-scoping mitgefixt, Rabatt als %+EUR additiv statt Modus. Task 4: task reviewer dispatched (sonnet), diff b0fe4dd..5fd14ed
Task 4: reviewer APPROVED (Low: MCP ohne discountAmount je Position; Actions/skonto-check ungetestet; Hinweis: IDOR-Rest in produkte/[id],
  teilgutschrift, abos/[id]). Ruling: MCP-Festbetrag + IDOR-Fixes als Commit 0 in Task 5; Route-/Action-Tests Backlog.
Task 4: complete
Task 5: dispatched (sonnet), BASE 5fd14ed, mit task-5-addendum.md + task-5-addendum-facts.md; kein eigenes Task-Review (Abschluss-Review prueft)
Task 5: implementer DONE (a85217e, 8f53f38, a04427a), 383/383, 13 Fixtures, PG 6/6 (Agent nach API-Timeout fortgesetzt).
Task 5: complete
Final: whole-branch review dispatched (opus), package review-3807287..a04427a.diff
Final: review (opus) — Kritisch K1 Angebots-PDF ohne Belegrabatt (pdf-data.ts), K2 UNTDID 48/54/59 → BR-DE-24/25 fatal; Wichtig W3 Skonto nicht im
  PDF bei vorbelegtem paymentTerms, W4 zwei Rundungswege (recurring computeLineNetCents); Gering G1-G11; Hinweise (Rechenprobe exakt, Skonto-UTC-Konvention,
  payment-Route ohne Org-Pruefung vorbestehend). Task 5 OK bis auf MCP create_invoice ohne discountAmount, ARCHITEKTUR-Satz, Testdatei unter unit.
Final: Ruling: EINE Fix-Welle: K1, K2 (+2 Fixtures 48/59), W3, W4, G-Punkte: detectSkonto-Auswahl + Toleranz, Reason-Label, Gutschrift-Darstellung abs,
  ARCHITEKTUR-Satz, MCP create_invoice, PaymentForm Methoden-Select, SKONTO nicht waehlbar, Skonto-Refine Satz, saveCustomer Org-Pruefung, payment-Route
  Org-Pruefung, Testdatei nach integration, UTC-Konvention kommentieren. Backlog: allocate bei Gewichtssumme 0, Audit fuer Zahlungsmethoden-CRUD.
Final: fix dispatched (sonnet, frisch), BASE a04427a
Final: fix commits 194eaf1, c73ef31, eb24f4e + Doku-Commit 904889c durch Koordinator (Agent parkte). Pruefkette durch Koordinator; scoped re-review dispatched (sonnet)
Final: re-review — 11/12 behoben; Rest: Vorzeichen im Gutschrift-Summenblock (PDF + Detailseite). Ruling: vorzeichenrichtig anzeigen, Gate per abs. Fix round 2 (haiku), Koordinator verifiziert im Diff.
Final: fix round 2 (223a0ad) durch Koordinator, 396/396. Merge phase-4a/pricing -> main (ff).
