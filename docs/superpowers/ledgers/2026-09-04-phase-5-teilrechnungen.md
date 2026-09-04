# Ledger Phase 5 — Teil-, Abschlags-, Schlussrechnungen (2026-09-04)

Branch `phase-5/partial-invoices` (Basis a99ceec). Plan: docs/superpowers/plans/2026-09-04-phase-5-teilrechnungen.md, Spec: 2026-09-03-phase-5-teilrechnungen-design.md.

## Tasks
| Task | Commits | Review | Fix-Runden |
|---|---|---|---|
| 1 Schema, Zod, Rechenkern | 5d09293, 628d48c | approved (2 minor) | 1 |
| 2 Domain (partial/downpayment/final, billingState, Zahlungen) | cc6195e, d716078, 4a578bf, 59d4a75 | not approved → approved | 2 |
| 3 PDF + E-Rechnung + Fixtures | c1717e0 (+ Koordinator d2ce17f CII-Reihenfolge) | approved | 0 |
| 4 Routen, UI, MCP | 6bdbaa1, 4976f64 | approved | 0 |
| 5 Postgres-Skript, Doku, §54-Test | ad423f4 | Abschluss-Review | — |

## Rulings
- Anteilsbasis nach Beleg-Rabatt/-Aufschlag der Quelle (computeTaxBreakdown), Σ = source.grossTotalCents.
- Storno einer Schlussrechnung: eine Summenzeile je Steuersatz, Beleganpassung 0, brutto = −payableCents.
- Ueberabrechnungs-Guard fuer alle Teilrechnungsmodi innerhalb der Transaktion.
- InvoiceLine.sourceLineId als zusaetzliche additive Migration (Plan-Luecke).
- Abzuege nur aus festgeschriebenen, nicht stornierten Abschlagsrechnungen; Snapshot in FinalInvoiceDeduction bei Festschreibung.
- Kein Mischen Teil-/Abschlag; Quelle ACCEPTED bei erster Teil-/Abschlagsrechnung.
- CII: InvoiceReferencedDocument allgemein (fehlte fuer 381/384); Charge vor Allowance (XSD D16B).
- Korrekturrechnung: nur Erklaertext, keine Erzeugung (Backlog). Teilgutschrift auf FINAL erlaubt.
- billingStateFor und chain.ts: Relationsrichtung PARTIAL_OF/DOWNPAYMENT_OF/FINAL_FOR (from = Rechnung) korrigiert.

## Befunde der Reviews (behoben)
- Task 1: unerreichbarer Gesamt-Overage-Check; fehlende Grenzfalltests.
- Task 2: kein Guard bei prozentualen Teilrechnungen (HIGH); FINAL-Storno warf bei Belegrabatt + gemischten Saetzen; plain Error statt 409-Klasse; doppelte Helfer; Anteilsbasis ohne Belegrabatt (Koordinator).
- Task 3: CII Allowance/Charge-Reihenfolge (Altfehler, behoben).

## Geparkt → Backlog
siehe backlog-nachtrag-phase-5.md

## Abschluss-Review (opus) und Fix-Welle
Nicht mergefaehig: B1 Rabatte in POSITIONS/QUANTITIES verloren (blocking), B2 E-Mail-Versand fuer neue Typen tot (blocking), B3 Guard-Luecke Share→Mengen, B4 Skonto-Check auf Brutto, B5/B6 Rundungscent (Bruttobetrag, FINAL-Storno), B7 Mahnung fuer neue Typen, B8 100 % Abschlag versteckt Schlussrechnung, B9 Abzugs-Snapshot nicht in Hash-Chain / kein Guard, B10 386 falsch beschriftet, B11 Lieferschein ohne UI-Einstieg, B12 preislose Lieferscheine, B13 Guards ausserhalb Tx, B14 Guard-Basis; Nits JSON 400, ARCHITEKTUR-Altsatz, COMPLIANCE BT-113.
Fix-Welle (sonnet, 8 Commits d3cfe47..b5dcb58): alle behoben; Residuen dokumentiert: ±1 Cent bei genau einem Steuersatz (B5/B6, LIMITATIONEN), READ-COMMITTED-Race verengt, nicht eliminiert (B13, LIMITATIONEN). 674 Tests, Postgres 7/7.
Rulings der Fix-Welle: Mahnung fuer PARTIAL/DOWNPAYMENT/FINAL erlaubt; Beleg-Festbetraege bei Positionsmodi proportional; Guard auf finalInvoiceDeduction (update/delete) in db.ts.
