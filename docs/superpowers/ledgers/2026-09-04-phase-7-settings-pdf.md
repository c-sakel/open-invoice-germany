# Ledger Phase 7 — Einstellungen, Nummernkreise, Briefpapier, Druckoptionen, GiroCode (2026-09-04)
Branch `phase-7/settings-pdf` (Basis 05ca6e2). Plan: docs/superpowers/plans/2026-09-04-phase-7-settings-pdf.md, Spec: 2026-09-04-phase-7-settings-pdf-design.md.

## Tasks
| Task | Commits | Review | Fix-Runden |
|---|---|---|---|
| 1 Schema, Zod, Settings-/Nummernkreis-Domain | 0901b5a | approved | 0 |
| 2 Konsum der Einstellungen, Kunden-/Artikelnummern, Wiederkehrend | 358e73b, a047101 | not approved → fixed | 1 |
| 3 PDF-Theme, Marken, GiroCode | 31df0ff, 835d380 | not approved (compress:false) → fixed | 1 |
| 4 UI/Routen/MCP | 1bc827a | approved (Doku-Luecke → Task 5) | 0 |
| 5 Postgres/Doku, MCP-Doku, save_document_settings entfernt | 7b0e6ed | Abschluss-Review | — |

## Rulings
- Angebot/AB/LS-Nummern bleiben bei Erstellung (§34-Abweichung dokumentiert); Backlog „Nummer erst beim Versand".
- refreshIssueDateOnFinalize gegen Systemuhr; shareLinkDefaultOn mintet beim Vorbelegen; offerLastDocument ab Phase 8; Waehrung optional mit Fallback DocumentSettings.defaultCurrency.
- PDF-Kompression als Theme-Option (Default an; Tests aus wegen pdf-parse 1.1.1); Paginierungs-Guard gegen pdfkit-Auto-Umbruch.
- GiroCode = openAmountCents, nur Rechnungstypen mit IBAN; EPC069-12 v002 byte-genau getestet.

## Abschluss-Review (opus) und Fix-Welle
Nicht mergefaehig: B1 Leerseite je PDF (Seitenzahl unter dem Rand), B2 GiroCode bei Fremdwaehrung mit „EUR", B3 „jaehrlich zuruecksetzen aus" ohne Wirkung (Vergabestellen lasen immer die Jahreszeile) → Duplikatgefahr; S1 Customer.defaultPaymentTermsDays ungenutzt, S2 Summenblock nicht am rechten Rand, S3 doppelter Footer, S4 Abo-Autoversand von Entwuerfen, S5 Abo-Formular Waehrung fest, S6 Druckoptionen nicht eingefroren, S7 Lieferadresse nicht aus Kundenadressen, S8 Kommentar, S9 kein MCP fuer Druckoptionen je Beleg; Nits.
Fix-Welle in zwei Teilen (sonnet; Teil 1 208efcb..9537053, Teil 2 100884a..e965922): alle behoben; 991 Tests; Postgres 10/10. Rulings: NumberRange.isActive + loadActiveRange fuer alle Vergabestellen, Jahr-Token Pflicht bei jaehrlichem Reset; GiroCode nur EUR; Frist Kunde > Zahlungsmethode > Settings > 14; autoSend erzwingt autoFinalize; Druckoptionen bei Festschreibung vollstaendig eingefroren; showDeliveryAddress = zusaetzlicher Lieferadressblock (SHIPPING-Default), Empfaenger bleibt.
Backlog: Unique auf customerNumber; Audit-Ansicht ChangeLog.
