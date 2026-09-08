# Ledger Phase 12a — Feinschliff (Dialoge, Textfelder, Vorschau, Logo, GiroCode)

Branch `phase-12a/feinschliff` aus Fork-main 9420a20, Plan `docs/superpowers/plans/2026-09-08-phase-12a-feinschliff.md`, Spec Paket A. Modelle: sonnet/opus. Ergebnis: 1855 Tests gruen, Gate komplett gruen, Smoke 12/12 + Fix-Smoke (Dialogbreiten 384/384/384/672 px, zentriert).

## Commits
- 7f92cae fix(ui): Dialoge wieder mittig (Tailwind-Preflight), gemeinsamer ConfirmDialog (Phase 12a, Task 1)
- 0bd92cc feat(pdf): GiroCode-Groesse als Druckoption, Logo bis 140 mm mit Hoehenbegrenzung (Phase 12a, Task 3)
- ab85d7a feat(editor): Kopf-/Fusstext ueber volle Breite mit Zeichenzaehler, breitere Vorschau mit Umschalter (Phase 12a, Task 2)
- 3410940 fix(ui): ConfirmDialog mit busy-Zustand und ARIA-Verknuepfung
- 3c40b0a docs(feinschliff): GiroCode-Groesse, Logogrenzen, Vorschau-Breite, Dialoge (Phase 12a, Task 4)
- b1d91e9 fix(ui): Fix-Welle Phase 12a — C1 (dialog:modal in @layer base) + I1 (Logo-Doku modern)
- bcb8d71 fix(ui,pdf): Fix-Welle Phase 12a — Minors M1-M7
- 023c9b5 fix(ui): Zahlenfelder klemmen erst beim Verlassen des Feldes (12a Fix 2)

## Verlauf, Befunde, Rulings (SDD-Ledger)


## Pre-flight scan
| Paar / Task | Produziert vs. konsumiert | Befund |
|---|---|---|
| T1 (globals.css, ConfirmDialog, EditorHeader, AttachmentPanel) vs T2 (HeadTextBlock, FootTextBlock, PreviewSheet, constants, CharCount) | disjunkt | parallel ok |
| T3 (prisma, schemas/settings, print.ts, Formulare, Migrationen, PG-Fall 16) vs T1/T2 | disjunkt | parallel ok |
| T4 Doku/Smoke | nach T1–T3 | sequentiell |
| Plan-Ruling: ConfirmDialog nur EditorHeader + AttachmentPanel; giroSizeMm -> PrintBooleanKey-Typ, freezePrintOptionsJson strenger (Review prueft) | — | uebernommen |
Modelle: Implementer/Reviews sonnet, Abschluss opus; T4 ohne eigenes Review. BASE 9420a20. T1–T3 parallel dispatcht.
Task 1: implementiert 7f92cae (Test-Regex mit Kommentar-Stripping; deleting-State entfernt). Review dispatcht.
Task 1: complete (Approved, 7f92cae). Fuer Task 4: ConfirmDialog busy-Prop (AttachmentPanel Loeschen ohne Feedback) + aria-labelledby/describedby; message als ReactNode.
Task 3: implementiert 0bd92cc (1847 Tests; PG-Fall 16 nur Syntax-Check). Review dispatcht.
Task 3: complete (Approved, 0bd92cc).
Task 2: implementiert ab85d7a (wide-State per setTimeout(0)). Review dispatcht. Task 4 dispatcht (letzter Task, kein eigenes Review; inkl. ConfirmDialog-Nachtraege).
Task 2: complete (Approved, ab85d7a).
Task 4: complete (3410940, 3c40b0a; Gate gruen 1847 Tests, Smoke 12/12). Abschluss-Review (opus) dispatcht.
Abschluss-Review (opus): Needs fix wave — C1 dialog:modal ungelayert ueberschreibt max-w-* (Dialoge bildschirmbreit); I1 Doku 35 mm Logo-Hoehe stimmt fuer modern nicht (~15 mm); 7 Minor. Fix-Welle dispatcht.
Fix-Welle: b1d91e9 (C1+I1) + bcb8d71 (M1–M7), 1855 Tests, Dialogbreiten 384/384/384/672 px zentriert. Scoped Re-Review dispatcht.
Fix-Welle Re-Review: alle Befunde adressiert; NEU Important: clamped-number-input klemmt je Tastendruck (18 -> 40). Fix-Runde 2 dispatcht (onBlur-Clamp, freier String waehrend Eingabe).
Fix-Runde 2: 023c9b5 (Clamp erst onBlur/Save, Draft-String; Koordinator-geprueft). Merge nach main.

## Offen / Backlog
- Postgres-Fall 16 nur per Inspektion (kein Docker lokal) — CI-Gate.
- GiroCode-Kollisionsschutz nur unten rechts; below-totals ueber ensurePlainSpace.
