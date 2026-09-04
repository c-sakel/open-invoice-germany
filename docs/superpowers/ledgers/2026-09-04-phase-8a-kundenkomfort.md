# Ledger Phase 8a — Kundenkomfort (2026-09-04)
Branch `phase-8a/customer-comfort` (Basis e965922). Plan: docs/superpowers/plans/2026-09-04-phase-8a-kundenkomfort.md, Spec: 2026-09-04-phase-8a-kundenkomfort-design.md.

## Tasks
| Task | Commits | Review | Fix-Runden |
|---|---|---|---|
| 1 Schema, Zod, Kundendomain | 97c6248 | approved | 0 |
| 2 Konsum, Snapshots, Platzhalter, Take-over | 8a1b93e, ecd896d | not approved (Kette/PDF-Kontakt) → fixed | 1 |
| 3 UI/Routen/MCP | 1d98a8a | approved | 0 |
| 4 Postgres/Doku | e36b158 | Abschluss-Review | — |

## Rulings
- Frist-Prioritaet (aus Phase 7): Kunde > Zahlungsmethode > Settings > 14; uebrige Vorgaben: explizit > Kunde > Settings > Default; Rabatt nur bei fehlenden Rabattfeldern (Create-Schemas ohne Default 0).
- Bestellreferenz → Invoice.orderNumber (BT-13) / Quote.customerReference.
- Snapshots: buyerSnapshotJson.address/customFields, contactSnapshotJson; Teil-/Abschlags-/Schlussrechnung erben INHERITED von der Quelle; Duplikat nimmt aktuelle Kunden-Defaults.
- Take-over reines Prefill (kein Beleg, keine Relation); Prompt nur bei offerLastDocument.
- Kontakt-Platzhalter auch in PDF-Kopf-/Fusstexten.
- Testjahre 2059–2062 mit eigenen NumberRange-Praefixen (Invoice.number global unique).

## Abschluss-Review (opus) und Fix-Welle
Nicht mergefaehig: B1 customField-Platzhalter tot (Pfad), B2 Lieferschein-Snapshot ueberschrieb Kaeufer-Postadresse mit Lieferadresse (BG-8-Risiko in Teilrechnungen), B3 Formulare sendeten null statt undefined (Kunden-Defaults griffen nie); S4 INHERITED-Snapshot bei Festschreibung verworfen, S5 Lieferschein-Nachdruck las Live-Default, S6 Rabatt-Vorbelegung blieb beim Kundenwechsel stehen, S7 Invoice.shippingAddressId ohne Wirkung; Nits.
Fix-Welle (sonnet, d3d8631..b3f85a0): alle behoben; 1138 Tests. Rulings: shippingAddress als eigener Schluessel in buyerSnapshotJson (kein neues Feld); finalizeWithinTx behaelt INHERITED; Formulare senden undefined bei leerem Selektor („— Standard des Kunden —"); Lieferadresse nur SHIPPING/OTHER; recurring/run.ts nicht refactored (Backlog); Invoice.shippingAddressId nicht nach BG-13/BG-15 gemappt (LIMITATIONEN + Backlog); vier weitere MCP-Tools.
