# Ledger Phase 13b — Editor (2026-09-10/11)

Branch phase-13b/editor aus main 0cac3fc, gemerged in Fork-main be31941. 13 Commits, 2169 Tests, SaxonJS-Schematron 41/41 (KoSIT-CI-Job prueft jetzt alle 21 Fixtures, continue-on-error entfernt), Smoke 6/6.
Plan: docs/superpowers/plans/2026-09-10-phase-13b-editor.md.

## Ergebnis
- Einspaltiger Editor, groessere Eingaben (inputCls), MoreOptions-Grid; Rechnungsdatum/Leistungsdatum gekoppelt (respektiert DocumentSettings.autoDeliveryDate); Zahlungsziel Tage+Datum (resolveDueDays = Kunde ?? Zahlungsart ?? Einstellungen ?? 14, dueDate nur gesendet wenn vom Nutzer gesetzt).
- Gesamtrabatt/Zuschlag als DocumentAdjustmentFields bei den Positionen (bestehende Felder, BG-20/21-Mapping unveraendert); Segmentumschalter netto/brutto (aria-pressed); "+ Produkt auswaehlen" in der Zeile.
- Betreff: PDF (alle Layouts, vor Kopftext) + UBL cbc:Note "#AAI#..." + CII IncludedNote (Content vor SubjectCode), trim, Fixture betreff-note. Ruling: auch auf festgeschriebenen Belegen gedruckt (LIMITATIONEN.md).
- Anhaenge im Entwurf: erster Upload legt Entwurf ueber bestehenden POST-Pfad an (Re-Entrancy-Guard, ein Beleg bei Doppel-Trigger); NICHT fuer Lieferscheine (kein Entwurfspfad, Hinweis).
- Command-Palette nutzt Unsaved-Guard mit ConfirmDialog; issueDate im Bearbeiten-Rundlauf lokal-tagfest.

## Backlog (Nits N1–N5, N7, N8 aus final-review.md, lokal)
- u. a. Escaping-Testabdeckung anderer Notizfelder, Lieferschein-DRAFT-Pfad (weiterhin), Editor-Dateigroessen.

## Hinweise 13c
- RowPaymentDialog (13a) wiederverwenden; ActionKeys wie in 13a-Ledger; MetaBlock-Props customers/invoiceDueDays beachten.
