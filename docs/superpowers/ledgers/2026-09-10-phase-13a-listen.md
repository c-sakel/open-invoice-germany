# Ledger Phase 13a — Listen (2026-09-10)

Branch phase-13a/listen aus main eb4c847, gemerged in Fork-main 0cac3fc. 13 Commits, 2127 Tests, Smoke 21/21.
Plan: docs/superpowers/plans/2026-09-10-phase-13a-listen.md. Spec: 2026-09-10-phase-13-listen-editor-beleg-design.md.

## Ergebnis
- AppShell max-w 1600px + PageContainer (Formularseiten schmal). relativeDueLabel, originsFor (Bulk).
- StatusTabs mit Zaehlern (prisma.count je Tab), ListHeadline (Rechnungen: Anzahl/Brutto/Offen/Ueberfaellig, groupBy currency, mixedCurrency-Hinweis; Dokumente/Lieferscheine: Anzahl).
- deriveBillingState (rein) + billingStateIndex (5 Bulk-Abfragen, Limit 5000 Relationszeilen -> Tabs Berechnet/Teilberechnet ausgeblendet).
- FilterBar sofortfilternd (Timer je Feld, URL-Sync, JS-freier Rueckfall, toleranter Cent-Parser, combo -> customerId oder q, ungueltige Schluessel einzeln verworfen).
- RowActionsMenu: Direktknoepfe PDF/Zahlung (RowPaymentDialog, generischer Rahmen fuer 13c), CONVERT via convertTargets (= Regel aus convert.ts), DocumentActionsMenuItems fuer Statuswechsel.

## Rulings
- Tab-Summen nicht disjunkt (partial ueberlappt open/due) -> Aequivalenztest je Tab statt Summenprobe.
- Nur EIN neuer ActionKey CONVERT; QUOTE_ACCEPT/REJECT ueber bestehende Uebergangstabelle; TEMPLATE_SAVE erst 13d.
- `tag` komplett entfernt bis 13d (keine Attrappe in API/OpenAPI).
- Lieferscheine: nur Anzahl als Kennzahl (Modell hat kein Brutto/Waehrung).
- Betreff wird auch auf festgeschriebenen Belegen gedruckt (Spec-Ruling, betrifft 13b).

## Backlog (Nits N1–N8 aus final-review.md, .superpowers lokal)
- Seed-DB ohne Angebote/Abos -> Smoke fuer Tabs Berechnet/Teilberechnet nur strukturell.
- quoteLine.findMany ohne direkten orgId-Filter (transitiv sicher, Altmuster).
- Lieferschein-DRAFT-Pfad (bekannt).

## Hinweise fuer 13c
- 13c-Plan geht von fuenf neuen ActionKeys aus -> anpassen: DELIVERY_NOTE existiert, Statuswechsel ueber DocumentActionsMenuItems, RowPaymentDialog wiederverwenden.
