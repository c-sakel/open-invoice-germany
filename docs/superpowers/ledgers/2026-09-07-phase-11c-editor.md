# Ledger Phase 11c — Gemeinsamer Beleg-Editor (DocumentEditor)

Branch `phase-11c/editor` aus Fork-main ffc6eb9, Plan `docs/superpowers/plans/2026-09-07-phase-11c-editor.md`, Spec `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md`.
Modelle: Implementer/Task-Reviews/Re-Reviews sonnet, Abschluss-Review opus. Ergebnis: 16 Commits, 1826 Tests gruen (TZ=UTC), Build/Lint/Typecheck/validate:erechnung/api:check gruen, Playwright-Smoke (Rechnung, Dokument AB, Lieferschein, Inline-Kunde, Kopftext Lieferschein, Sidebar-Guard) gruen.

## Commits
- 41c98d5 feat(editor): Entwurfsmodell, Reducer, Payload-Mapper und Summen als reine Funktionen (Phase 11c, Task 1)
- 6ef3418 fix(editor): Prozent-Eingaben in Summen wie im Payload geklemmt (Task 1 Fix 1)
- d360231 feat(editor): POST /api/pdf/preview rendert ungespeicherte Entwuerfe mit Wasserzeichen (Phase 11c, Task 2)
- f8de86c feat(editor): Kundensuche mit Inline-Anlage und Textvorlagen-Auswahl (Phase 11c, Task 3)
- 1cdcb73 fix(editor): Lieferschein-Vorschau nutzt dieselben Anzeige-Defaults wie createDeliveryNote; 500 bei internen Fehlern (Task 2 Fix 1)
- 76b0421 fix(editor): Kundentyp CONSUMER aus dem Schema, Fokus nach Inline-Anlage, Escape schliesst Suche (Task 3 Fix 1)
- b9c2501 feat(editor): DocumentEditor-Rahmen mit Kopfbloecken, Optionen und Anhaengen (Phase 11c, Task 4)
- e3fd39c fix(editor): Kopf-/Fusstext fuer Rechnungen, Versanddatum und interne Notiz fuer Lieferscheine im Payload (Task 1 Fix 2)
- ff840ea fix(editor): Kopftext an headerText fuer Rechnungen gebunden (Task 4 Fix 1)
- 0b970ad feat(editor): Positionstabelle mit Produktsuche, Summenblock, Fusstext, Vorschau-Sheet (Phase 11c, Task 5)
- b245def feat(editor): Seiten auf DocumentEditor umgestellt, alte Formulare entfernt (Phase 11c, Task 6)
- 52d359b fix(editor): Review-Fixes Task 5 — Fokus-Trap, Lieferschein-Rabatt, Zeilentyp-Wechsel
- 075fbdf chore(editor): Altverweise auf entfernte Formulare bereinigen
- 80340c8 docs(editor): DocumentEditor, Vorschau, Anleitung und Grenzen (Phase 11c, Task 7)
- 52295c9 fix(editor): Fix-Welle Phase 11c — Important (I1-I5)
- 5434e7d fix(editor): Fix-Welle Phase 11c — Minor (M1-M14)

## Verlauf, Befunde, Rulings (SDD-Ledger, unveraendert uebernommen)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 -> T4/T5/T6 | DraftState/DraftAction/draftReducer/emptyDraft/draftFromX/toXPayload/validateDraft; computeDraftTotals; constants; parse | konsistent |
| T2 -> T5 | POST /api/pdf/preview {kind,payload,layoutId}; PreviewSheet sendet toXPayload(draft,false) | konsistent; Test nutzt ?compress=0 nur in NODE_ENV=test (Ruling) |
| T3 -> T4 | CustomerPicker/NewCustomerDialog/TextTemplatePicker; createCustomerInline; ggf. Listen-Route /api/text-templates | konsistent; Route-Existenz prueft T3 |
| T4 <-> T5 | DocumentEditor Platzhalter "Positionen" in T4, T5 haengt LineItemsEditor/TotalsBlock/FootTextBlock/PreviewSheet ein | ok |
| T6 | Seiten + Loeschung der drei Formulare; TakeOverPrompt-Anbindung an dispatch replace | ok |
| T1 Tests | Zahlen in editor-totals.test.ts gegen bestehende Pricing-Funktionen nachrechnen (Plan sagt: Funktionen sind Referenz) | Hinweis im Brief |
Rulings: Festschreiben bleibt auf der Detailseite (kein Doppelpfad); Lieferschein-Bearbeitung nicht in 11c; Teilgutschrift-Formular bleibt.
Modelle: Implementer/Task-Reviews sonnet, Abschluss opus. Letzter Task (7) ohne eigenes Review.
Task 1: implementiert 41c98d5 (Abweichungen: DeliveryNote-Payload wie heutiges Formular; SCHEME_* aus tax.ts/mandatory.ts wiederverwendet; applyProduct-Guard ueber productId). Review dispatcht. Task 2 dispatcht.
Task 1: review — Important: computeDraftTotals klemmt Prozent nicht (Formular tat es), Inkonsistenz zu Payload-Mappern. Fix-Runde 1/5 dispatcht (Helfer in parse.ts zentralisieren, Tests). Minor: Report-Zaehlung SCHEME_* (kein Codeeinfluss). Deviation applyProduct-Guard: akzeptiert (Brief-Vorgabe), UX in Task 5/6 beobachten.
Task 1: fix round 1/5 (1 addressed; commit 6ef3418, Helfer zentral in parse.ts, Tests 17/17). Ruling: vom Koordinator geprueft (kleiner Diff) — kein Re-Review-Seat.
Task 1: complete (commits ffc6eb9..41c98d5 + 6ef3418)
Task 2: implementiert d360231 (Lieferschein-Vorschau: show-Flags default true statt Org-dnShow*; Test-DB-Flake durch parallele Laeufe). Review dispatcht. Task 3 dispatcht.
Task 2: review — Important (plan-mandated): Lieferschein-Vorschau-Flags default true statt Org-dnShow*/showTax=false wie create.ts; Minor: 400 statt 500 bei internen Fehlern, duenne DOCUMENT/DN-Tests, redundanter Org-Load. Fix-Runde 1/5 dispatcht (Important + beide Minors).
Task 3: implementiert f8de86c (neue Listen-Route GET /api/text-templates; next/cache-Mock im Test). Review dispatcht. Task 4 dispatcht (parallel zur Task-2-Fixrunde, disjunkte Dateien).
Task 2: fix round 1/5 (Important + 2 Minors; commit 1cdcb73). Ruling: Koordinator-Pruefung des Diffs (Flag-Fallback wie create.ts sichtbar, 500-Mapping) — kein Re-Review-Seat.
Task 2: complete (commits 6ef3418..d360231 + 1cdcb73)
Task 3: review — Critical: Kundentyp PRIVATE statt CONSUMER (Fehler im Brief!); Important: Fokusverlust nach Inline-Anlage (Dialog im Dropdown), Escape schliesst nicht immer; Minor: inputCls dupliziert, Zod-Fehlertexte englisch (vorbestehend), Route ohne getCurrentUserId (wie Sibling). Fix-Runde 1/5 dispatcht.
Task 3: fix round 1/5 (4 addressed; commit 76b0421). Ruling: Koordinator-Pruefung des Diffs — kein Re-Review-Seat; Fokus/Escape werden im Abschluss-Smoke geprueft.
Task 3: complete (commits d360231..f8de86c + 76b0421)
Task 4: implementiert b9c2501. Ruling: Rechnungen bekommen Kopf-/Fusstext im Editor (Backend unterstuetzt es komplett; altes Formular bot es nie an) — Task-1-Fix-2 (Payload) + Task-4-Fix-1 (Bindung) parallel dispatcht (disjunkte Dateien); Lieferschein-Payload +shippingDate/internalNotes. Ein Primaerknopf + Vorschau akzeptiert; kein Betreff fuer Lieferschein akzeptiert. Review Task 4 nach beiden Fixes.
Task 1: fix round 2/5 (commit e3fd39c: headerText/footerText im Rechnungs-Payload, shippingDate/internalNotes im Lieferschein-Payload; 19/19). Koordinator-geprueft.
Task 4: fix round 1/5 (commit ff840ea: headerText-Bindung, notes in MoreOptions, TakeOver traegt header/footer). Review dispatcht (Range 76b0421..ff840ea inkl. Task-1-Fix-2). Task 5 dispatcht (inkl. Vorlagen-Autovorbelegung fuer neue Rechnungen).
Task 4: complete (commits 76b0421..ff840ea, review clean). minor (deferred): narrowTaxRate dupliziert (RecipientBlock vs draft.ts) -> Task 6 exportiert aus draft.ts; Prefill ohne AbortController; EditorField required nur visuell.
Task 5: implementiert 0b970ad (Abweichungen: kein Typwechsel je Zeile nach Anlage; DN ohne HEADING/TEXT/SUBTOTAL-Links; Rabatt %/€ ein Feld; set-state-in-effect-Muster). Review dispatcht. Task 6 dispatcht (Seiten, alte Formulare loeschen, narrowTaxRate-Export, Prisma-select fuer Adressvorschau).
Task 5 Review: Needs fixes — Important: (1) PreviewSheet ohne Fokus-Uebernahme (Escape wirkungslos, Tab in Tabelle), (2) DN-Rabattfeld interaktiv, aber toDeliveryNotePayload verwirft ihn, (3) LineDiscountField-Heuristik "0" vs "0,00" -> Modus € statt % bei jeder Bestandsrechnung, (4) UnitSelect schaltet nicht auf "andere…" wenn Produkt fremde Einheit setzt. Minor: Totals doppelt/unmemoisiert, disabled USt-Select zeigt Rohwert statt 0, aria-labels/scope fehlen, expanded-Toggle setzt dirty.
Ruling: Zeilentyp-Wechsel nach Anlage wird in der Fix-Runde als Menuepunkt "Typ aendern" nachgeruestet — Betreiber schreibt taeglich Belege, das alte Formular konnte es (Regression) — Kosten bei Irrtum: ein Menuepunkt mehr.
Fix-Runde 1 wartet, bis Task 6 (parallel im selben Baum) committet hat.
Task 6: implementiert b245def (Smoke 13/13, 1810 Tests). Review dispatcht. Task 5 Fix-Runde 1 dispatcht (frischer sonnet-Implementer, Task-5-Agent nach Kompaktierung nicht mehr adressierbar).
Task 6: complete (Review Approved, b245def). Minor fuer Task 7: 26 Kommentar-Verweise auf NewInvoiceForm/NewDocumentForm/DeliveryNoteForm bereinigen.
Task 5 Fix-Runde 1: 52d359b (alle 11 Befunde, 1819 Tests). Scoped Re-Review dispatcht. Task 7 dispatcht (Doku + Kommentarbereinigung + volles Gate; kein eigenes Review).
Task 5: complete (Re-Review Clean, 52d359b). Beobachtung fuer Polish: PreviewSheet onClose inline -> useCallback.
Task 7: complete (075fbdf, 80340c8; Gate gruen inkl. validate:erechnung + api:check, 1819 Tests). Abschluss-Review (opus) dispatcht ueber ffc6eb9..80340c8.
Abschluss-Review (opus): Needs fix wave — 0 Critical, 5 Important (I1 DN Kopf/Fusstext nicht gesendet, I2 showDeliveryAddress nie gesendet, I3 crypto.randomUUID nur im Secure Context, I4 Speichern ohne Issue-Details + validateDraft ohne description-Pflicht, I5 Unsaved-Guard deckt Sidebar nicht ab), 15 Minor. Datei .superpowers/sdd/plan-11c/final-review.md.
Ruling: EINE Fix-Welle (sonnet) fuer I1–I5 + M1–M14, danach Smoke wiederholen (M15) und scoped Re-Review. I5 wird erweitert (Klick-Abfang auf Shell-Links bei dirty), nicht nur dokumentiert — Betreiber verliert sonst getippte Belege.
Fix-Welle: 52295c9 (I1–I5) + 5434e7d (M1–M14), 1826 Tests, Smoke wiederholt. Scoped Re-Review dispatcht.
Fix-Welle Re-Review: Clean (alle I1–I5, M1–M14 adressiert; Restnotiz M10: drei select-Casts in MetaBlock, Optionen == Union). Offen (bewusst): Command-Palette router.push umgeht den Unsaved-Guard; Lieferschein-Bearbeitung (11d/spaeter).

## Offene Punkte fuer 11d / Backlog
- Unsaved-Guard deckt Sidebar/Topbar-Links ab, nicht die Command-Palette (router.push).
- Lieferscheine: nur Anlegen im Editor; Bearbeiten bleibt in 11d oder spaeter.
- PreviewSheet onClose als useCallback (Polish); MetaBlock select-Casts durch Zod-Parse ersetzen (Polish).
- Betreiber-Abnahme: Kunde, drei Positionen per Produktsuche, Vorschau, Speichern < 1 Minute.
