# Ledger Phase 6 — Mahnwesen und Scheduler (2026-09-04)
Branch `phase-6/dunning` (Basis b5dcb58). Plan: docs/superpowers/plans/2026-09-04-phase-6-mahnwesen.md, Spec: 2026-09-04-phase-6-mahnwesen-design.md.

## Tasks
| Task | Commits | Review | Fix-Runden |
|---|---|---|---|
| 1 Schema, Zod, Stufen/Settings, Guard | 8ad0663 (+ Koordinator 2ed79d1 Schema-Drift) | not approved (Drift) → Koordinator-Fix | 0 |
| 2 Mahn-Engine | b202795 | approved | 0 |
| 3 Scheduler | 003a765, 1782b07 | not approved (Lock-Race) → approved nach Fix | 1 |
| 4 UI/Routen/MCP | c1653d2 | approved (N+1 → Task 5) | 0 |
| 5 Postgres/Doku, N+1-Fix | 2fd7f19 | Abschluss-Review | — |

## Rulings
- Testjahre neu vergeben (2045/2046 waren belegt): 2050–2053.
- Zinsen je Mahnung = Gesamtzinsen seit Faelligkeit; Stufenbasis = dueDate der Vormahnung; gracePeriodDays nur Stufe 0; `force` nur manuell.
- Altmahnungen ohne Betrags-Snapshot (claimBaseCents 0, Live-Fallback), Stammdaten-Snapshot per Selbstheilung MIGRATION.
- SchedulerLock-Tabelle (PK job) als atomarer Mutex; SchedulerRun nur Protokoll; stale 30 min.
- Postgres-Migrationen per `prisma migrate diff --script`, wenn `migrate dev` non-interaktiv verweigert.

## Abschluss-Review (opus) und Fix-Welle
Nicht mergefaehig: B1 40-€-Pauschale doppelt (take:1), B2 Erst-Deploy mahnt Altbestand, B3 Cron-Routen ohne CRON_SECRET offen; S1 Pause ohne Datum, S2 Selbstheilung ohne Aufrufer + 0,00-€-Fallback, S3 Reorder ohne Invarianten, S4 NaN-Intervall, S5 entschaerfter Test, S6 Overview ohne select/where, S7 Basiszins-Label; Nits.
Fix-Welle (sonnet, 11 Commits 49ca51c..05ca6e2): alle behoben; 823 Tests. Rulings: Bestandsorgs autoCreate=false, neue true; alle Cron-Routen fail-closed (503 ohne Secret); pausedUntil Pflicht; claimBase nur bei snapshotSource CREATE; Reorder revalidiert; SCHEDULER_ENABLED false|0|no|off.
Deploy-Hinweis: SCHEDULER_ENABLED=false beim ersten Start, /mahnwesen sichten, dann einschalten; CRON_SECRET setzen.
