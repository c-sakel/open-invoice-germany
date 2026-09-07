# Ledger Phase 11d — Belegansicht (DocumentDetailLayout)

Branch `phase-11d/detail` aus Fork-main 2047bd3, Plan `docs/superpowers/plans/2026-09-07-phase-11d-detail.md`, Spec `docs/superpowers/specs/2026-09-07-phase-11-sevdesk-ux-design.md`.
Modelle: Implementer/Task-Reviews/Re-Reviews sonnet, Abschluss-Review opus. Ergebnis: 13 Commits, 1833 Tests gruen (TZ=UTC), Build/Lint/Typecheck/validate:erechnung/api:check gruen, Playwright-Smoke 12/12 + Fix-Welle 10/10.

## Commits
- b688962 feat(detail): Layout-Bausteine, PdfStack, Statuskarte, Mehr-Menue, NavHint (Phase 11d, Task 2)
- 4ebe008 feat(detail): Nachbarn in der aktuellen Liste, ?liste= an Zeilen-Links (Phase 11d, Task 1)
- 57f285b fix(detail): deaktivierte Pfeile nicht fokussierbar, Mehr-Menue ueber Sticky-Kopf (Task 2 Fix 1)
- 50ef60e feat(detail): Rechnungsansicht PDF-zentriert mit Statuskarte und Mehr-Menue (Phase 11d, Task 3)
- d77953d fix(detail): Task 3 Fix 1 — Duplizieren-Sperre, Status-Badge im Kopf, Menue-Stil, Zahlungszeilen
- 834b001 feat(detail): Dokument- und Lieferscheinansicht auf DocumentDetailLayout, PdfPreview entfernt (Phase 11d, Task 4)
- c7e36af fix(shell): Gruppen auf-/zuklappbar, Fokusfalle und Scroll-Sperre fuer Palette und Drawer (Phase 11d, Task 5)
- ccfcad5 fix(shell): Task 5 Fix 1 — aktive Gruppe zuklappbar, Escape nur fuer oberste Ebene, getFocusable
- 7b3a9e3 fix(detail): Statuskarte zeigt Status auch bei Dokument und Lieferschein
- e53890b docs(detail): Belegansicht, Navigation, Grenzen (Phase 11d, Task 6)
- 283bae8 fix(detail): Fix-Welle Phase 11d — Important 1-4 (PDF-Knopf, kompakte Aktionen, interne Notiz, Zahlungsmethode)
- a6bbd57 fix(detail): Fix-Welle Phase 11d — Minor-Funde + Doku-Korrekturen
- cf40758 fix(detail): ConvertMenu als Menuezeile auch bei Dokument und Lieferschein

## Verlauf, Befunde, Rulings (SDD-Ledger, unveraendert uebernommen)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 -> T3/T4 | loadNeighbors(kind, orgId, id, liste) -> {prevId,nextId,backQuery}; Listen haengen ?liste= an | konsistent; `from` ist Datumsfilter -> Name `liste` |
| T2 -> T3/T4 | DocumentDetailLayout-Slots, DetailNav, PdfStack, StatusCard, ActionMenu(+Item/Separator), CollapsibleSection, NavHint | konsistent |
| T2 <-> Sidebar | ShellProvider bekommt navHint; Sidebar/Drawer-Sidebar lesen ihn | Sidebar liegt in ShellProvider (AppShell) — ok |
| T3/T4 <-> alte Seiten | alle Komponenten/Actions muessen erhalten bleiben (Pruefpunkt 1) | Brief verlangt grep-Abgleich |
| T4 -> PdfPreview | Loeschung erst nach Umstellung aller drei Seiten (T3 nutzt PdfStack) | Reihenfolge T3 vor T4 |
| T5 | unabhaengig (Shell); nav.test.ts wird von T2 und T5 beruehrt | T5 nach T2 |
| T1 Tests | listInvoices limit max 200 (schemas/index.ts:566) — NEIGHBOR_LIMIT 200 | ok |
Rulings: Druckoptionen-Menuepunkt fuer Rechnungen NICHT (kein Panel auf der Rechnungsseite, Layout im Editor); Lieferschein-PDF im Entwurf bleibt aus (wie heute); DocumentActions-Statusknoepfe bleiben sichtbar (Primaeraktionen des Typs).
Modelle: Implementer/Task-Reviews sonnet, Abschluss opus. Letzter Task (6) ohne eigenes Review. T1 und T2 parallel (disjunkte Dateien).
Task 1 + Task 2 dispatcht (parallel, disjunkt). BASE 2047bd3.
Task 2: implementiert b688962. Review dispatcht.
Task 1: implementiert 4ebe008 (1832 Tests). Review dispatcht. Task 3 dispatcht (BASE 4ebe008).
Task 1: complete (Review Approved, 4ebe008). Minors fuer Task 4: listeQuerySchema-Regex um '*' ergaenzen; dokumente/lieferscheine values um offset erweitern (Zurueck-Link auf richtige Seite).
Task 2: review — Important: disabled-Pfeile per Tastatur aktivierbar; Minor z-index. Fix-Runde 1 vom Koordinator (tabIndex -1 + preventDefault, z-30), Koordinator-geprueft. Task 2: complete.
Task 3: implementiert 50ef60e (Bearbeiten-Knopf neben Festschreiben behalten; Duplizieren im Menue folgt canDuplicate). Review dispatcht. Task 4 dispatcht (BASE 50ef60e).
Task 3: review — Important: Duplizieren im Mehr-Menue ohne !isDraft/!isCancelled (Mehr-Knopf neu im Entwurf); StatusBadge nur im Aside statt im Kopf (Report falsch). Minor: Menue-Eintraege mit Wrapper-div ohne Hover/Breite; Bezahlt/Offen-Zeilen auch bei Gutschrift/Entwurf/Storno.
Rulings: Duplizieren gate = canDuplicate && !isDraft && !isCancelled (altes Verhalten); StatusBadge im Kopf UND als Kartenstatus; Bezahlt/Offen/Zahlungsmethode nur bei isInvoiceType && !isDraft && !isCancelled; Menue-Eintraege einheitlich stylen. Fix-Runde 1/5 an den Task-3-Implementer.
Task 3: fix round 1/5 (d77953d, 4 addressed, Koordinator-geprueft). Task 3: complete. Task 5 dispatcht parallel zu Task 4 (disjunkt: shell/nav).
Task 4: implementiert 834b001 (Snapshot statt Live-Relation fuer Adresse/Ansprechpartner; StatusCard status=null im Aside). Review dispatcht.
Task 5: implementiert c7e36af. Review dispatcht.
Task 4: complete (Review Approved, 834b001). Fuer Task 6: StatusCard status={<StatusBadge/>} auf Dokument- und Lieferschein-Karte (Konsistenz zu Rechnung); Kommentar zum Snapshot-Fallback in DocumentStatusCard.
Task 5: review — Critical: aktive Gruppe nicht zuklappbar (effectiveOpen = ... || isActiveGroup dauerhaft); Important: Escape schliesst Palette UND Drawer; Minor: getFocusable-Helfer. Fix-Runde 1/5 an den Task-5-Implementer.
Task 5: fix round 1/5 (ccfcad5, 3 addressed, Koordinator-geprueft). Task 5: complete. Task 6 dispatcht (letzter Task, kein eigenes Review).
Task 6: complete (7b3a9e3, e53890b; Gate gruen, 1833 Tests, Smoke 12/12). Befund: Lieferschein-DRAFT im UI unerreichbar (createDeliveryNoteWithinTx -> CREATED), in LIMITATIONEN. Abschluss-Review (opus) dispatcht ueber 2047bd3..e53890b.
Koordinator-Sichtung Screenshots: (a) Dokument-Detail: 9 Knoepfe in der Aktionszeile (DocumentActions Statuswechsel) -> Fix-Welle: nur Bearbeiten + erster Uebergang + PDF + E-Mail in actions, Rest ins Mehr-Menue (DocumentActions compact-Modus); (b) Rechnungs-Mehr-Menue: Duplizieren/Lieferschein erzeugen als Rahmenknoepfe statt Menuezeilen. Sidebar-Fuss 'N'-Overlay = Next-Dev-Indikator, kein Bug.
Abschluss-Review (opus): Needs fix wave — 0 Critical, 4 Important (I1 PDF-Knopf auf Rechnungsseite fehlt/Doku falsch, I2 Knopfwand Dokumentseite, I3 interne Notiz im zugeklappten Positionen-Block, I4 Zahlungsmethode-Zeile weggeguardet), 16 Minor. Datei .superpowers/sdd/plan-11d/final-review.md.
Rulings Fix-Welle: I1 PDF als Aktionsknopf auf allen drei Seiten (wie Dokument/Lieferschein), ANLEITUNG korrigieren; I2 DocumentActions bekommt compact-Modus: actions = Bearbeiten(DRAFT) + erster Statusuebergang + PDF + E-Mail, alle weiteren Uebergaenge/Archiv/Duplizieren als Menuezeilen im Mehr-Menue; I3 interne Notiz auf allen drei Seiten ausserhalb des Positionen-Blocks (immer sichtbar), Positionen bleiben zugeklappt (Spec); I4 Zahlungsmethode ungeguardet; M2 Kundenanschrift+USt-IdNr als Kartenzeilen; M12 Alt-Pfeile behalten, in ANLEITUNG/LIMITATIONEN dokumentieren; M8/M9/M14/M16 akzeptiert (dokumentiert); Rest fixen.
Fix-Welle: 283bae8 (I1–I4) + a6bbd57 (M1–M16), 1833 Tests, Smoke 10/10. Scoped Re-Review dispatcht.
Fix-Welle Re-Review: Clean (alle I1–I4, M1–M16; neu Minor N1 DocumentActions default-Variante ungenutzt, N2 getrennter busy-State Kopf/Menue — Backlog). Koordinator-Nachtrag cf40758: ConvertMenu asMenuItem auf Dokument/Lieferschein. Merge nach main.

## Offen / Backlog
- Lieferschein-DRAFT im UI unerreichbar (createDeliveryNoteWithinTx -> CREATED); DRAFT-Ansicht bleibt (LIMITATIONEN).
- DocumentActions default-Variante ohne Aufrufer (N1); Kopf/Menue mit getrenntem busy-State (N2, Server prueft Uebergaenge -> 409).
- Vor/Zurueck nur innerhalb der ersten 200 Treffer; Alt+Pfeile kollidieren unter Windows/Linux mit Browser-Zurueck (dokumentiert).
- <details>-Menues schliessen nicht bei Klick ausserhalb (dokumentiert).
