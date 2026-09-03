# Phase 5 — Teilrechnung, Abschlagsrechnung, Schlussrechnung: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aus Angebot/AB/Lieferschein Teilrechnungen (Anteil, Betrag, Positionen, Teilmengen) und aus Angebot/AB Abschlagsrechnungen erzeugen; eine Schlussrechnung weist die Gesamtleistung aus und setzt festgeschriebene Abschläge nach § 14 Abs. 5 UStG ab — in PDF, XRechnung/ZUGFeRD (BT-113, BG-3), Zahlungen, Kette und MCP; Abrechnungsstand der Quelle wird abgeleitet.

**Architecture:** Neue Rechnungstypen `PARTIAL`, `DOWNPAYMENT`, `FINAL` auf `Invoice.type`; Erzeugung über `src/domain/invoice/partial.ts`, `downpayment.ts`, `final.ts` (nutzen `createDraftInvoiceWithinTx`, Pricing, `linkDocuments`); Abzugs-Snapshot `FinalInvoiceDeduction` beim Festschreiben; `payableCents` als offener Betrag der Schlussrechnung; Mapper/PDF/XML lesen Snapshot; `billingStateFor` (3a) und `remainingQuantities`-Muster für berechnete Anteile.

**Tech Stack:** wie bisher (Next.js 16, Prisma 6.19.3 SQLite+Postgres, Zod 4, vitest, pdfkit, KoSIT/Mustang-Validator).

**Spec:** `docs/superpowers/specs/2026-09-03-phase-5-teilrechnungen-design.md` (Branch `specs`; Kopie im Scratchpad).

## Global Constraints

- Geld Integer-Cent; Anteile in Permille; Aufteilung je Steuersatz mit `allocateProportional` (4a); Σ Abschläge ≤ Gesamtleistung (Fehler sonst).
- GoBD: alle drei Typen sind Rechnungen (Entwurf → `finalizeWithinTx` → Storno/Gutschrift); Abzugs-Snapshot unveränderlich; ChangeLog in derselben Tx; Relationen nur über `linkDocuments`.
- E-Rechnung: DOWNPAYMENT = UNTDID 1001 `386`; FINAL = `380` mit BT-113 (Paid amount = Σ Abschläge brutto), BT-115 = Rest, BG-3 je Abschlag (BT-25 Nummer, BT-26 Datum), BT-22 Note mit Abzugsaufstellung (netto/USt je Abschlag); Validator-Gate mit neuen Fixtures (UBL+CII) — Audit K1 gilt sinngemäß: kein Merge ohne grüne Validierung.
- Zod an jeder Boundary und in Domain-Funktionen; beide Schemas byte-gleich; Migrationen additiv; Postgres-Skript +1 Tabelle (30).
- Testjahr **2040**. Prüfkette im Vordergrund: typecheck, lint, test, build, validate:erechnung.

---

### Task 1: Schema, Zod, Rechenkern (TDD)
- Prisma (beide): `Invoice.sourceType String?`, `sourceId String?`, `partialPermille Int?` (Anteil bei Prozent-Teil/Abschlag), `prepaidCents Int @default(0)`, `payableCents Int?` (null = grossTotal); neu `FinalInvoiceDeduction { id, finalInvoiceId, downpaymentInvoiceId, number, issueDate, netCents, taxCents, grossCents, taxRate, taxCategory, createdAt }` (Index `[finalInvoiceId]`, Unique `[finalInvoiceId, downpaymentInvoiceId, taxRate, taxCategory]`). Migration `phase5_partial_invoices` additiv.
- Zod: `InvoiceType` + `PARTIAL | DOWNPAYMENT | FINAL`; `createPartialInvoiceSchema { sourceType: "QUOTE"|"DELIVERY_NOTE", sourceId, mode: "PERCENT"|"NET_AMOUNT"|"GROSS_AMOUNT"|"POSITIONS"|"QUANTITIES", permille?, amountCents?, lineIds?, quantities?[{ sourceLineId, quantityMilli }] }`, `createDownpaymentInvoiceSchema { sourceType: "QUOTE", sourceId, mode: "PERCENT"|"AMOUNT", permille?, amountCents?, amountIsGross?: boolean }`, `createFinalInvoiceSchema { sourceType: "QUOTE", sourceId }`.
- Rechenkern `src/lib/pricing/partial.ts` (pure): `splitByTaxRate(buckets, permille | amountCents, gross?)` → je Satz Netto/USt (Largest-Remainder; bei Bruttobetrag Rückrechnung je Satz mit Rundungsausgleich), `deductionsFor(finalBuckets, downpayments[])` → Restbeträge je Satz und gesamt; Tests: 10.000 € 19 % + 30 % + 30 % → 3.000/570/3.570 je Abschlag, Rest 4.000/760/4.760; gemischte Sätze 19/7 mit Bruttobetrag 1.000 € → Aufteilung exakt; Σ Abschläge > Gesamt → `PricingError`.
- Commit `feat(partial): Schema, Zod und Rechenkern fuer Teil-, Abschlags- und Schlussrechnungen`.

### Task 2: Domain — Teilrechnung, Abschlag, Schluss, Abrechnungsstand (TDD)
- `src/domain/invoice/partial.ts` `createPartialInvoice(orgId, rawInput, opts)`: Quelle org-geprüft (Quote kind ANGEBOT/AB mit Status DRAFT/SENT/ACCEPTED; Lieferschein CREATED/SENT/DELIVERED); PERCENT/NET/GROSS → eine ITEM-Zeile je Steuersatz „Teilleistung x % zu <Quelle Nr.>" (Beträge aus `splitByTaxRate`); POSITIONS/QUANTITIES → Positionskopien (Teilmengen gegen bereits berechnete Mengen prüfen: `billedQuantities(orgId, sourceType, sourceId)` analog `remainingQuantities`, nur Rechnungen ≠ CANCELLED); `type: "PARTIAL"`, `sourceType/sourceId`, Kopf-/Fußtext/Zahlungsmethode/Skonto der Quelle übernehmen; Relation `PARTIAL_OF` (from Rechnung, to Quelle); Quelle → ACCEPTED (Quote) falls DRAFT/SENT; ChangeLog. Alles in einer Tx.
- `downpayment.ts` `createDownpaymentInvoice`: nur Quote (ANGEBOT/AB) ohne Teilrechnungen (Ruling: kein Mischen; Fehler sonst); Zeile je Satz „Abschlag x % auf <Quelle Nr.>"; `type: "DOWNPAYMENT"`, `partialPermille`; Relation `DOWNPAYMENT_OF`; Σ bisheriger Abschläge (festgeschrieben + Entwürfe? Ruling: nur festgeschriebene zählen für die 100-%-Grenze, Entwürfe werden beim Festschreiben geprüft) ≤ 100 %.
- `final.ts` `createFinalInvoice`: nur Quote mit ≥ 1 festgeschriebener, nicht stornierter Abschlagsrechnung und ohne bestehende nicht stornierte FINAL; Positionen = Gesamtleistung (Kopie aller ITEM/Block-Zeilen der Quelle, Pricing der Quelle); `type: "FINAL"`; Relation `FINAL_FOR`; Abzüge werden ERST beim Festschreiben als `FinalInvoiceDeduction` gesnapshottet (`finalizeWithinTx`: für `type === "FINAL"` alle festgeschriebenen, nicht stornierten DOWNPAYMENT-Rechnungen der Quelle laden, Deductions schreiben, `prepaidCents` = Σ brutto, `payableCents` = gross − prepaid; Fehler, wenn prepaid > gross). Storno eines Abschlags nach Festschreibung der Schlussrechnung → erlaubt, aber Hinweis im UI (Backlog: automatische Korrektur nicht).
- `billingStateFor` (3a) erweitern: PARTIAL bei PARTIAL_OF/DOWNPAYMENT_OF ohne FINAL; FULL bei FINAL_FOR (festgeschrieben) oder Σ Teilrechnungs-Anteile ≥ 1000 ‰ / alle Mengen berechnet; Rückgabe + `billedPermille`, `downpaymentGrossCents`.
- Zahlungen: `recordPayment` nutzt `payableCents ?? grossTotalCents` als Bemessung (offener Rest, PAID-Grenze, Skonto-Basis); `openCents` überall (Mahnwesen später) über Helper `openAmountCents(invoice)` in `src/domain/invoice/amounts.ts`.
- Storno/Gutschrift: `cancel.ts` spiegelt `type` (Storno einer Abschlagsrechnung bleibt CREDIT_NOTE mit `sourceType` Verweis) und `FinalInvoiceDeduction` wird NICHT kopiert (Storno-Gutschrift setzt keinen Abschlag ab — Ruling; Storno der Schlussrechnung erstattet den Rest). Konvertierung/Duplizieren: neue Typen nicht duplizierbar (Fehler).
- Tests (§54): Beispiel 10.000/30/30/Schluss; Storno eines Abschlags vor Schluss (nur einer wird abgesetzt); zweite Schlussrechnung verboten; Teilrechnung 40 % + 60 % → FULL; POSITIONS/QUANTITIES mit Überberechnung → Fehler; Zahlung auf Schlussrechnung 4.760 → PAID; Skonto-Basis = payable; `verifyChain`.
- Zwei Commits: `feat(partial): Teil- und Abschlagsrechnungen`, `feat(partial): Schlussrechnung mit Abzugs-Snapshot, Abrechnungsstand, Zahlungen`.

### Task 3: PDF und E-Rechnung
- `EInvoiceData`: `invoiceType` (380/381/384/386 aus `type`), `prepaidCents`, `payableCents`, `deductions[]`, `sourceNumber`; Mapper aus Snapshot (`FinalInvoiceDeduction`), nie live.
- PDF: Titel „Teilrechnung"/„Abschlagsrechnung"/„Schlussrechnung"; Bezug „zu Angebot/Auftrag <Nr.>"; Schlussrechnung: Summenblock Gesamtleistung netto/USt/brutto, je Abschlag „abzüglich Abschlagsrechnung RE-… vom … −x,xx € (enthaltene USt y,yy €)", „Restbetrag" fett; Abschlagsrechnung: Hinweis „Anzahlung, Steuer wird mit Vereinnahmung geschuldet (§ 13 Abs. 1 Nr. 1 Buchst. a Satz 4 UStG)".
- UBL/CII: `InvoiceTypeCode` 386 für DOWNPAYMENT; FINAL: 380, `cac:BillingReference/cac:InvoiceDocumentReference` je Abschlag (BT-25 ID, BT-26 IssueDate) — Reihenfolge laut XSD (nach `OrderReference`, vor Parties; Bestand hat bereits BillingReference für Korrekturen — erweitern), `cbc:PrepaidAmount` (BT-113) und `cbc:PayableAmount` (BT-115) in `LegalMonetaryTotal`; CII `ram:InvoiceReferencedDocument` (mehrfach) und `ram:TotalPrepaidAmount`/`ram:DuePayableAmount`; BT-22 `cbc:Note` mit Abzugsaufstellung. Fixtures: `downpayment-386`, `final-with-two-downpayments`, `partial-percent` (UBL+CII) — Validator grün; Unit-Test BR-CO-16 (Payable = TaxInclusive − Prepaid).
- Commit `feat(partial): PDF und E-Rechnung fuer Abschlags- und Schlussrechnungen`.

### Task 4: Routen, UI, MCP
- Routen: `POST /api/documents/[id]/partial-invoice`, `/downpayment-invoice`, `/final-invoice`; `POST /api/delivery-notes/[id]/partial-invoice`; Zod; 409 bei Regelverstoß.
- UI: `ConvertMenu` (3a) erweitern: „Teilrechnung…" (Dialog: Modus, Wert, Positions-/Mengenauswahl mit bereits berechneten Anteilen), „Abschlagsrechnung…" (Prozent/Betrag), „Schlussrechnung erzeugen" (nur wenn Abschläge festgeschrieben); Detailseiten: Abrechnungsstand-Badge mit Prozent, Liste der Teil-/Abschlagsrechnungen, Kette (3a) zeigt PARTIAL_OF/DOWNPAYMENT_OF/FINAL_FOR; Rechnungsseite: Typ-Badge, Bezug zur Quelle, Abzugsblock (aus Snapshot), offener Betrag = payable; §16-Aktionsblock mit Erklärtexten (Storno, Teilgutschrift, Korrektur, Duplizieren) auf der Rechnungsseite.
- `LineItemsTable`/PDF: Teilrechnungs-Zeilen sind normale ITEMs.
- MCP: `create_partial_invoice`, `create_downpayment_invoice`, `create_final_invoice`.
- Commits: `feat(partial): Routen und MCP`, `feat(partial): UI fuer Teil-, Abschlags- und Schlussrechnungen`. Manuelle Prüfung: Angebot 10.000 € → 2 Abschläge 30 % → festschreiben → Schlussrechnung → PDF/XML prüfen (`validate:erechnung` auf die heruntergeladene Datei) → Zahlung 4.760 → PAID.

### Task 5: Postgres-Test, Doku, COMPLIANCE
- Tabellenzahl 30; Fall 6 unverändert.
- COMPLIANCE.md: § 14 Abs. 5 UStG (Abschlags-/Endrechnung), Abschn. 14.8 UStAE, KoSIT-Empfehlung BT-113/BG-3, UNTDID 386 — mit Quellen; LIMITATIONEN (kein Mischen Teil/Abschlag, Storno eines Abschlags nach Schlussrechnung ohne automatische Korrektur, Skonto nur auf Rest); ARCHITEKTUR; README.
- Commit `docs(partial): Teil-, Abschlags- und Schlussrechnungen dokumentiert`.

## Self-Review
§13 (Modi, Anteile, Status) T1/T2/T4; §14 (Prozent/Betrag, mehrere, Verknüpfung) T2/T4; §15 (Darstellung, Zahlungen, Steuer) T2/T3; §16 (UI-Erklärung, Kette) T4; §52 T3 mit Gate; §55 T4. Typen: `splitByTaxRate` in `pricing/partial.ts`; `FinalInvoiceDeduction` Prisma; `openAmountCents` in `invoice/amounts.ts`.
