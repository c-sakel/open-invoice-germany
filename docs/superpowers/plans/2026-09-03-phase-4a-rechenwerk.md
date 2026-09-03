# Phase 4a — Rabatte, Aufschläge, Skonto, Zahlungsmethoden, E-Rechnungs-Mapping: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Positions- und Belegrabatte sowie Aufschläge steuerlich korrekt berechnen und in XRechnung/ZUGFeRD als AllowanceCharge abbilden; Skonto strukturiert modellieren (PDF, BT-20, Zahlungseingang mit Skonto-Vorschlag); Zahlungsmethoden im UI pflegen, an Rechnungen wählen und als PaymentMeans ins XML mappen.

**Architecture:** Reines Rechenmodul `src/lib/pricing/` (Positionsnetto, Belegrabatt-/Aufschlags-Aufteilung mit Largest-Remainder, Skonto-Beträge/-Fristen) ohne DB; `computeTaxBreakdown` bleibt die Steuerquelle, bekommt aber die Aufteilung je Satz; Domain (`createDraftInvoice`, `finalize`, `recordPayment`) nutzt das Modul; Mapper/UBL/CII schreiben AllowanceCharge/PaymentTerms/PaymentMeans; Validatoren erweitert um Fixtures.

**Tech Stack:** Next.js 16, TypeScript strict, Prisma 6.19.3 (SQLite + Postgres), Zod 4, vitest, xmlbuilder2 (bestehend), KoSIT/Mustang-Validatoren (`npm run validate:erechnung`).

**Spec:** `docs/superpowers/specs/2026-09-03-phase-4-rechnungskomfort-design.md` (Abschnitte 4a) — Kopie `scratchpad/plan/2026-09-03-phase-4-rechnungskomfort-design.md`.

## Global Constraints

- Geld ausschließlich Integer-Cent, Mengen Integer-Milliunits; Rundung nur an definierten Stellen (Positionsnetto, Aufteilung, Steuer je Satz); Σ der aufgeteilten Beträge muss exakt dem Gesamtrabatt/-aufschlag entsprechen.
- Rabatt-Feature und AllowanceCharge-Mapping werden nie getrennt ausgeliefert (Audit K1): Task 1–3 sind eine Einheit; kein Merge ohne grünen `validate:erechnung` mit den neuen Fixtures.
- GoBD: festgeschriebene Rechnungen unveränderbar — neue Felder wirken nur auf Entwürfe; `taxBreakdownJson` ist Snapshot; Zahlungen nur über `recordPayment`; ChangeLog in derselben Tx.
- Zod an jeder Boundary und in Domain-Funktionen; keine Prisma-Enums; beide Schemas byte-gleich; Migrationen additiv mit Defaults.
- Bestehende Belege ohne Rabatt/Skonto rendern und validieren unverändert (Regressionsfixtures).
- Prüfkette: `npm run typecheck && npm run lint && npm test && npm run build && npm run validate:erechnung`. Testjahr **2034**.
- Deutsche Kommentare/UI; Commit-Messages ohne Umlaute; `git commit -s` mit Trailern.

---

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `src/lib/pricing/line.ts` | `computeLineNet({ quantityMilli, unitNetPriceCents, discountPermille, discountCents })` |
| `src/lib/pricing/allocate.ts` | `allocateProportional(total, weights[])` (Largest Remainder), `applyDocumentAdjustments(breakdownBase, { discountPermille, discountCents, chargePermille, chargeCents })` |
| `src/lib/pricing/skonto.ts` | `skontoTerms(invoice)` → `[{ permille, days, dueDate, amountCents }]`, `detectSkonto(invoice, payment, now)` |
| `src/lib/tax.ts` | `computeTaxBreakdown(lines, adjustments?)` → Breakdown mit `allowanceCents`/`chargeCents` je Satz; `TaxBreakdownEntry` erweitert |
| Prisma (beide) + Migration `phase4a_pricing` | `InvoiceLine.discountCents`, `QuoteLine.discountCents`, Beleg-Felder Rabatt/Aufschlag/Skonto an `Invoice` und `Quote`, `Invoice.paymentMethodId` + `paymentMethodSnapshotJson`, `Payment.skontoForPaymentId`, `PaymentMethod.bankIban/bankBic/bankName`, Systemcode `SKONTO` (defaults.ts) |
| `src/schemas/index.ts` | `invoiceLineInputSchema` + `discountCents`; `createInvoiceSchema`/`createDocumentSchema` + Beleg-Felder + `paymentMethodId`; `recordPaymentSchema` + `applySkonto`; `paymentMethodSchema` |
| `src/domain/invoice/{create,finalize}.ts`, `src/domain/document/{create,update,convert}.ts` | Berechnung über Pricing-Modul; Snapshot der Zahlungsmethode beim Festschreiben |
| `src/domain/invoice/payment.ts` | Skonto-Erkennung/-Buchung, `SKONTO`-Systemcode |
| `src/domain/masterdata/{defaults,ensure}.ts`, `src/domain/payment-method/manage.ts` | Systemcode SKONTO, CRUD |
| `src/lib/einvoice/{types,mapper,xrechnung,cii}.ts` | AllowanceCharge Zeile + Dokument, LegalMonetaryTotal BT-107/108, PaymentTerms BT-20 mit Skonto-Syntax, PaymentMeansCode/Konto aus Methode |
| `src/lib/pdf/invoice-pdf.ts` | Rabattzeile je Position, Beleg-Rabatt/-Aufschlag-Block, Skonto-Absatz, Zahlungsmethoden-Text |
| `scripts/validate-erechnung.ts` (+ Fixtures unter `test/fixtures/erechnung/`) | Fixtures: Positionsrabatt, Belegrabatt bei 2 Sätzen, Aufschlag, Skonto, Zahlungsmethode CASH |
| Routen/Actions/UI | `NewInvoiceForm` (Rabattfelder je Position, Beleg-Rabatt/-Aufschlag, Skonto, Zahlungsmethode), `PaymentForm` (Skonto-Vorschlag), Einstellungen → Zahlungsmethoden, Kundenformular Default-Methode; MCP `record_payment` + `applySkonto`, `create_invoice` + Felder |
| Tests | `test/unit/pricing.test.ts`, `test/unit/skonto.test.ts`, `test/unit/einvoice-allowance.test.ts`, `test/integration/payment-skonto.test.ts`, `test/integration/payment-methods.test.ts` |

---

### Task 1: Rechenmodul (pure, TDD)

**Files:** `src/lib/pricing/{line,allocate,skonto}.ts`, `src/lib/tax.ts`; Tests `test/unit/pricing.test.ts`, `test/unit/skonto.test.ts`.

**Interfaces (Produces):**

```ts
// line.ts
export interface LineInput { quantityMilli: number; unitNetPriceCents: number; discountPermille?: number; discountCents?: number }
export function computeLineNet(l: LineInput): { grossLineCents: number; discountTotalCents: number; lineNetCents: number }
// grossLineCents = Math.round(quantityMilli * unitNetPriceCents / 1000); pct = Math.round(grossLineCents * discountPermille / 1000);
// lineNetCents = max(0, grossLineCents - pct - discountCents); discountTotalCents = grossLineCents - lineNetCents

// allocate.ts
export function allocateProportional(totalCents: number, weights: readonly number[]): number[]
// Largest Remainder: floor-Anteile, Rest nach groesstem Bruchteil verteilen; Σ == totalCents; weights alle 0 → alles auf Index 0 (oder [] bei leerem Array)
export interface DocumentAdjustments { discountPermille?: number; discountCents?: number; chargePermille?: number; chargeCents?: number }
export interface RateBucket { key: string; taxRate: number; taxCategory: string; netCents: number }
export function applyDocumentAdjustments(buckets: RateBucket[], adj: DocumentAdjustments): Array<RateBucket & { allowanceCents: number; chargeCents: number; adjustedNetCents: number }>
// D = discountCents + round(Σnet * discountPermille/1000); D_r = allocateProportional(D, net_r); Basis_r = net_r - D_r;
// C = chargeCents + round(ΣBasis * chargePermille/1000); C_r = allocateProportional(C, Basis_r); adjustedNet_r = Basis_r + C_r; nie negativ (Fehler bei D > Σnet)

// skonto.ts
export interface SkontoTerm { permille: number; days: number; dueDate: Date; amountCents: number; payableCents: number }
export function skontoTerms(i: { issueDate: Date; grossTotalCents: number; skonto1Permille: number | null; skonto1Days: number | null; skonto2Permille: number | null; skonto2Days: number | null }): SkontoTerm[]
export function detectSkonto(terms: SkontoTerm[], paidAt: Date, amountCents: number, openBeforeCents: number): SkontoTerm | null
// Treffer, wenn paidAt <= term.dueDate (Tagesende) und amountCents >= term.payableCents - 1 und amountCents < openBeforeCents
export function paymentTermsText(terms: SkontoTerm[], netDueDate: Date | null): string  // "2 % Skonto bei Zahlung bis 10.06.2034 (Skontobetrag 23,80 €), zahlbar netto bis 17.06.2034."
export function xrechnungSkontoNote(terms: SkontoTerm[], text: string): string       // "#SKONTO#TAGE=7#PROZENT=2.00#\n#SKONTO#TAGE=14#PROZENT=1.00#\nZahlbar ..." (Prozent mit 2 Nachkommastellen, Punkt)
```

`computeTaxBreakdown(lines, adjustments?)`: baut Buckets je (taxRate, taxCategory), ruft `applyDocumentAdjustments`, Steuer je Satz = `round(adjustedNet * taxRate / 100)`; `TaxBreakdownEntry` + `allowanceCents`, `chargeCents`, `baseNetCents` (vor Anpassung); `TaxTotals` + `allowanceTotalCents`, `chargeTotalCents`, `lineTotalCents` (Σ Zeilen vor Anpassung). Ohne `adjustments` identisch zum Bestand (Regressionstest gegen bisherige Ergebnisse).

- [ ] Tests (Lastenheft §54): Positionsrabatt 10 %/5 €/beide; 100 € 19 % + 100 € 7 %, 10 % → 10/10, Steuer 17,10/6,30, brutto 203,40; Festbetrag 15 € auf 300/100 → 11,25/3,75; drei Buckets 33,33/33,33/33,34 mit 10 € → Summe exakt 1000 Cent; Aufschlag 5 % nach Rabatt; Rabatt > Netto → Fehler; 0 %-Satz (Kleinunternehmer) mit Rabatt; Reverse-Charge unverändert; Skonto: 2 %/7 Tage auf 1190 → 23,80, payable 1166,20; zwei Ziele; `detectSkonto` innerhalb/außerhalb/Teilzahlung; BT-20-Syntax; Regressionstest ohne Anpassungen.
- [ ] Commit `feat(pricing): Rechenmodul fuer Rabatte, Aufschlaege und Skonto`.

### Task 2: Schema, Zod, Domain

**Files:** Prisma + Migration `phase4a_pricing` (beide Dialekte); `src/schemas/index.ts`; `src/domain/invoice/{create,finalize,payment}.ts`; `src/domain/document/{create,update,convert,duplicate}.ts`; `src/domain/masterdata/{defaults,ensure}.ts`; neu `src/domain/payment-method/manage.ts`; Tests `test/integration/payment-skonto.test.ts`, `test/integration/payment-methods.test.ts`, Erweiterung `gobd.test.ts` (Rabattrechnung festschreiben).

- Felder: `InvoiceLine.discountCents Int @default(0)`, `QuoteLine.discountCents`; `Invoice`/`Quote`: `documentDiscountPermille Int @default(0)`, `documentDiscountCents Int @default(0)`, `documentChargePermille Int @default(0)`, `documentChargeCents Int @default(0)`, `documentChargeReason String?`; `Invoice`: `skonto1Permille Int?`, `skonto1Days Int?`, `skonto2Permille Int?`, `skonto2Days Int?`, `paymentMethodId String?`, `paymentMethod PaymentMethod?` (SetNull), `paymentMethodSnapshotJson String?`; `Payment.skontoForPaymentId String?`; `PaymentMethod.bankIban/bankBic/bankName String?`; Systemcode `SKONTO` („Skonto", untdid „ZZZ", sortOrder 9) in `SYSTEM_PAYMENT_METHODS` — Selbstheilung legt ihn nach; **Backfill** in der Migration: INSERT SKONTO je Org (Muster Phase-1-Backfill, `WHERE NOT EXISTS`).
- Zod: `invoiceLineInputSchema` + `discountCents: z.number().int().nonnegative().default(0)`; Beleg-Felder in `createInvoiceSchema`/`createDocumentSchema`/`updateDocumentSchema` (Permille 0–1000, Cents ≥ 0); Skonto-Felder (Permille 1–1000, Tage 1–365, Ziel 2 nur mit Ziel 1 und Tage2 > Tage1); `paymentMethodId` optional; `recordPaymentSchema` + `applySkonto: z.boolean().default(false)`; `paymentMethodSchema` (name, description, paymentTermsDays, invoiceText, bankIban/bic/name, isActive) für CRUD.
- Domain: `createDraftInvoice`/`createBusinessDocument`/`updateDraftDocument`: Zeilen über `computeLineNet`, Summen über `computeTaxBreakdown(lines, adjustments)`; Beleg-Felder persistieren; Konvertierung überträgt Rabatte/Aufschlag/Skonto/Zahlungsmethode. `finalizeWithinTx`: `paymentMethodSnapshotJson` = `{ code, name, invoiceText, untdidCode, bankIban, bankBic, bankName }` (aus Methode, sonst null). `recordPayment(invoiceId, input, opts)`: nach Zahlungsanlage `detectSkonto`; bei Treffer und `applySkonto` → zweite Zahlung `{ amountCents: openRest, method: "SKONTO", isSkonto: true, skontoForPaymentId, paidAt }`, ChangeLog `PAYMENT`/`SKONTO`; Rückgabe `{ payment, skontoSuggestion?: SkontoTerm & { restCents }, skontoPayment? }`; ohne `applySkonto` nur Vorschlag. `payment-method/manage.ts`: `listPaymentMethods`, `savePaymentMethod` (System: nur name/description/text/bank/isActive), `deletePaymentMethod` (nur nicht-System, nicht referenziert).
- [ ] Tests: Rechnung mit Positions- und Belegrabatt festschreiben → Snapshot-Breakdown mit allowance; Zahlung innerhalb Skontofrist ohne `applySkonto` → Vorschlag, offen bleibt; mit `applySkonto` → zwei Zahlungen, Rechnung PAID, ChangeLog-Kette gültig; außerhalb Frist → kein Vorschlag; Zahlungsmethoden-CRUD, Systemschutz, Snapshot beim Festschreiben, Default aus Kunde. Postgres-Skript: Fall 6 prüft 9 PaymentMethods je Org nach Backfill.
- [ ] Commits: `feat(pricing): Schema und Zod fuer Rabatte, Skonto und Zahlungsmethoden`, `feat(pricing): Domain mit Rabattrechnung, Skonto-Zahlung und Zahlungsmethoden`.

### Task 3: E-Rechnung und PDF

**Files:** `src/lib/einvoice/{types,mapper,xrechnung,cii}.ts`, `src/lib/pdf/invoice-pdf.ts`, `scripts/validate-erechnung.ts`, `test/fixtures/erechnung/*.json`, `test/unit/einvoice-allowance.test.ts`.

- `EInvoiceData` + `lines[].discountCents/discountPermille/grossLineCents`, `documentAllowances[]/documentCharges[]` je Satz `{ amountCents, baseCents, taxRate, taxCategory, reason }`, `allowanceTotalCents`, `chargeTotalCents`, `lineTotalCents`, `paymentTermsNote` (BT-20 mit Skonto-Syntax), `paymentMeans { code, iban?, bic?, accountName? }` aus Snapshot der Methode (Fallback Org-Konto, Code 58).
- UBL: je Zeile mit Rabatt `cac:AllowanceCharge` (ChargeIndicator false, `cbc:Amount`, `cbc:BaseAmount`, bei Prozent `cbc:MultiplierFactorNumeric`) **vor** `cac:Item` (Reihenfolge laut XSD: `InvoicePeriod, OrderLineReference, …, AllowanceCharge, Item, Price`); `cbc:LineExtensionAmount` = lineNet; `cac:Price/cbc:PriceAmount` = Einzelpreis. Dokument: je Satz `cac:AllowanceCharge` mit `cac:TaxCategory` **vor** `cac:TaxTotal`; `LegalMonetaryTotal`: `LineExtensionAmount` = Σ Zeilen, `AllowanceTotalAmount`, `ChargeTotalAmount`, `TaxExclusiveAmount` = Σ − A + C, `TaxInclusiveAmount`, `PayableAmount`. `cac:PaymentTerms/cbc:Note` = Skonto-Syntax + Text. `cac:PaymentMeans/cbc:PaymentMeansCode` aus Snapshot; `PayeeFinancialAccount` aus abweichendem Konto.
- CII analog: `ram:SpecifiedTradeAllowanceCharge` in `ram:SpecifiedLineTradeSettlement` bzw. `ram:ApplicableHeaderTradeSettlement`; `ram:SpecifiedTradeSettlementHeaderMonetarySummation` mit `AllowanceTotalAmount`/`ChargeTotalAmount`; `ram:SpecifiedTradePaymentTerms/ram:Description`; `ram:TypeCode` der PaymentMeans.
- PDF: Rabattzeile unter der Position („abzgl. 10 % Rabatt −12,00 €"), Block Zwischensumme/Rabatt/Aufschlag vor Steuern, Skonto-Absatz, Zahlungsmethoden-Text (`invoiceText`) statt/zusätzlich zu `paymentTerms`.
- Fixtures + `validate:erechnung`: fünf neue Belege (Positionsrabatt, Belegrabatt 2 Sätze, Aufschlag, Skonto zwei Ziele, CASH) für UBL und CII; Bestandsfixtures unverändert grün. Unit-Test prüft BR-CO-10/11/13-Summen rechnerisch (Σ LineExtension − Allowance + Charge = TaxExclusive).
- [ ] Commit `feat(einvoice): AllowanceCharge, Skonto in BT-20 und PaymentMeans aus Zahlungsmethode`.

### Task 4: Routen, Actions, UI, MCP

- `NewInvoiceForm`: je Position Rabatt % / Rabatt €; Beleg-Rabatt/-Aufschlag (Prozent oder Betrag, Grund); Skonto (zwei Ziele); Zahlungsmethode (Select, vorbelegt aus Kunde), Zahlungsziel-Vorschlag; Live-Summen im Formular über das Pricing-Modul (Client-Import erlaubt — pure).
- `NewDocumentForm` (Angebot/AB): dieselben Rabatt-/Aufschlagsfelder.
- `PaymentForm`: nach Eingabe von Betrag/Datum `GET /api/invoices/[id]/skonto-check?amountCents=&paidAt=` → Vorschlag anzeigen („2 % Skonto möglich, Rest 23,80 € als Skonto buchen?") mit Checkbox `applySkonto`.
- Einstellungen → Zahlungsmethoden (Tab): Liste, Bearbeiten (Systemcodes: Name/Text/Bank/aktiv), Neu, Löschen; Kundenformular: Default-Zahlungsmethode.
- Rechnungsseite: Rabatt/Aufschlag/Skonto/Zahlungsmethode anzeigen; Zahlungen mit Skonto-Kennzeichen.
- MCP: `create_invoice`/`create_document` mit neuen Feldern; `record_payment` mit `applySkonto`; `list_payment_methods`.
- [ ] Commits: `feat(pricing): Routen, Actions und MCP fuer Rabatte, Skonto und Zahlungsmethoden`, `feat(pricing): Editor, Zahlungsformular und Zahlungsmethoden im UI`. Manuelle Prüfung: Rechnung 100 € 19 % + 100 € 7 % mit 10 % Belegrabatt → PDF zeigt 20 € Rabatt, XRechnung/ZUGFeRD validieren; Zahlung 1166,20 innerhalb 7 Tagen → Skonto-Vorschlag → bezahlt.

### Task 5: Postgres-Test, Doku

- Postgres-Fall 6: 9 PaymentMethods je Org; Tabellenzahl unverändert 28.
- LIMITATIONEN (Skonto nur BT-20-Text, keine Fremdwährung, Rabatt nicht negativ), ARCHITEKTUR (Pricing-Modul, Aufteilungsregel), COMPLIANCE.md (EN 16931 BG-20/21, XRechnung-Skonto-Syntax mit Quelle: XRechnung-Spezifikation, Abschnitt „Skonto"), README (Rabatte/Skonto/Zahlungsmethoden kurz).
- [ ] Commit `docs(pricing): Rabatte, Skonto und Zahlungsmethoden dokumentiert`.

## Self-Review

- §10 (Rabatt/Aufschlag, Aufteilung, Tests) T1–T3; §11 (Skonto Felder/PDF/XML/Zahlung) T1–T4; §12 (Zahlungsmethoden UI/Text/Konto/Kunden-Default) T2–T4; §52 Mapping T3 mit Validator-Gate; §55 MCP T4. §7-Kopfdaten/§8/§9/§38 → Plan 4b.
- Typkonsistenz: `RateBucket`/`DocumentAdjustments` in `allocate.ts`, von `tax.ts` importiert; `SkontoTerm` in `skonto.ts`, von `payment.ts`/`mapper.ts`/`invoice-pdf.ts` genutzt.
