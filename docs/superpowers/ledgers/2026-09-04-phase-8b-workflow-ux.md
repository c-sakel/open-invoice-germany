# Ledger Phase 8b — Workflow/UX (2026-09-04)
Branch `phase-8b/workflow-ux` (Basis b3f85a0). Plan: docs/superpowers/plans/2026-09-04-phase-8b-workflow-ux.md, Spec: 2026-09-04-phase-8b-workflow-ux-design.md.

## Tasks
| Task | Commits | Review | Fix-Runden |
|---|---|---|---|
| 1 Status, Filter, Aktionsmatrix, Zahlungsnotiz, Abo-Erweiterungen | 191708f | approved | 0 |
| 2 Listen-UI, Schnellaktionen, Zahlungsdialog, Abo-Formular | 2269682, 80bbbdf, 24d64a3 | not approved (3 Rulings) → fixed | 1 |
| 3 ActivityLog, Timeline, Benachrichtigungen | fa8a304 | approved | 0 |
| 4 Dashboard, Kundendetail, Timeline-UI, Benachrichtigungen, Navigation, MCP | 1ffc701, c513ad5 | not approved (KPIs/Aging/Abo-Edit) → fixed | 1 |
| 5 Postgres/Doku | 0646a64 | Abschluss-Review | — |

## Rulings
- Status faellig/ueberfaellig rein abgeleitet (effectiveInvoiceStatus), Filter serverseitig; ciContains je Provider.
- REMINDER = Mahnstufe 0 ueber Mahnroute + Mahnungs-Versanddialog; Listen tragen hasEmailLog; Zahlungsmethode Kunde > Org.
- Abo: DAY-Intervall, maxRuns → ENDED nach Lauf, emailTemplateId beim Autoversand, showPeriodText je Abo (Default aus Settings, nicht rueckwirkend).
- ActivityLog eigene Tabelle ohne Hash-Kette; Timeline ab 8b; Aging-Buckets Dashboard §45 vs. Mahnuebersicht §25.

## Abschluss-Review (opus) und Fix-Welle
Nicht mergefaehig: B1 Listenseiten warfen bei Filter-Submit (rohe searchParams); S1 PARTIALLY_PAID nie faellig/ueberfaellig (offen 0 €), S2 Umsatz zaehlte Abschlagsketten doppelt, S3 showPeriodText-Default ohne Backfill, S4 Benachrichtigungs-Schalter ohne Wirkung auf Hooks / EMAIL_BOUNCED ohne Erzeuger, S5 Dashboard-Vollscan, S6 Mahnaktionen bei pausiertem Prozess, S7 lokale vs. UTC-Tagesgrenzen, S8 logActivity in Transaktionen unter Postgres nicht blockierungsfrei; Nits.
Fix-Welle (sonnet, 4a7bb04..60fb585): alle behoben; 1284 Tests; Postgres 13/13. Rulings: parseListQuery + Default-Fallback; teilbezahlt faellt in den Faelligkeitszweig mit Flag partiallyPaid; Umsatz = Σ payableBaseCents; Migration phase8b_fixwave (Backfill showPeriodText, Notification unique [orgId, dedupeKey]); Hooks pruefen enabledTypes, EMAIL_BOUNCED als inaktiv markiert; countDunningCandidates mit gemeinsamem where-Builder; UTC-Tagesgrenzen; S8 nur Doku (Backlog: ActivityLog nach Commit).
