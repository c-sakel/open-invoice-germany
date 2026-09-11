# Ledger Phase 13d — Vorlagen und Tags (2026-09-11)

Branch phase-13d/vorlagen-tags aus main a19e12e, gemerged in Fork-main 6145ce6. 18 Commits, 2289 Tests, PG-Skript 23 Faelle / 48 Tabellen, Schematron 42, Smoke 19/19.
Plan: docs/superpowers/plans/2026-09-10-phase-13d-vorlagen-tags.md. PHASE 13 KOMPLETT.

## Ergebnis
- Modelle Tag, DocumentTag (polymorph, unique orgId+tagId+docType+docId), DocumentTemplate (payloadJson strict, ohne interne Notizen/Nummern/Daten). Migrationen 20260913090100_phase13d_templates, 20260913092100_phase13d_tags (SQLite + PG), PG-Faelle 22/23 -> 35 Migrationen.
- Tag-Domain (ActivityLog TAG_ADDED/REMOVED/DELETED, an festgeschriebenen Belegen erlaubt, Org-Isolation via assertDocExists); Vorlagen-Domain (save/create/update/rename/delete/list/apply — apply nur ueber createDraftInvoice/createBusinessDocument/createDeliveryNote, Steuersatz-Pruefung greift, customerId-Ownership).
- UI: /vorlagen, /einstellungen/tags, TagPicker in Details-Karte, Tag-Filter in allen Listen (in *FilterConditions -> Tabs/Kennzahlen konsistent, cache(), Limit 5000), "Als Vorlage speichern" (ActionKey TEMPLATE_SAVE).
- REST v1: /Tag (GET/POST, GET/PATCH/DELETE {id}, POST assign/unassign), /DocumentTemplate (GET/POST, GET/PATCH/DELETE {id}, POST apply); RouteSpec.method um DELETE erweitert; OpenAPI driftfrei. MCP: 8 Tools (98 gesamt).
- Leck-Tests: Tags nie in PDF/XML/Mail/oeffentlichem Link. NotFoundError statt Error bei fehlendem Kunden in invoice/document create (404 statt 500). dunning-routes.test.ts deterministisch.

## Rulings
- DELETE bodylos, assign/unassign als POST (withApi parst Body nur bei POST/PATCH/PUT).
- Lieferschein-Vorlage erzeugt den Beleg direkt (kein Lieferschein-Editor), landet auf der Detailseite (LIMITATIONEN).

## Backlog (Nits 9–16 aus final-review.md, lokal)
- 4 Altstellen "Kunde nicht gefunden" als Error (Adressen, recurring/create.ts, delivery-note/create.ts); kind-Feld unabhaengig von docType; weitere Barrierefreiheits-Nits.
