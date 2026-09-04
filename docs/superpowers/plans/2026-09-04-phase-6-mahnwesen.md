# Phase 6 — Mahnwesen und Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flexible Mahnstufen mit Stufen-getriebener Geldlogik, Mahnprozess-Status je Rechnung, Snapshots für Mahnungen, eingebauter Scheduler mit Cron/API-Fallback, Mahnübersicht `/mahnwesen`, Settings-UI, MCP-Tools.

**Architecture:** Domain unter `src/domain/dunning/` (stages, settings, schedule, create, send, state, snapshot, overview) bleibt rein und transaktional; Scheduler-Runner `src/domain/scheduler/` mit DB-Lock (`SchedulerRun`) und seriellen Jobs (dunning, recurring); `src/instrumentation.ts` startet den Intervall-Runner im Node-Prozess; Cron-Routen und `npm run dunning:run` rufen dieselbe Runner-Funktion. UI: `/mahnwesen`, `Einstellungen → Mahnwesen`, `Einstellungen → Automatisierung`, Rechnungsseite.

**Tech Stack:** Next.js 16, Prisma 6 (SQLite + Postgres, zwei Migrationen), Zod 4, vitest, pdfkit, Phase-2-Mailpipeline.

**Spec:** docs/superpowers/specs/2026-09-04-phase-6-mahnwesen-design.md (Branch specs) — Ist-Stand in phase-6-ist-stand.md (Scratchpad).

## Global Constraints
- GoBD: Mahnung = Geschäftsbrief → Snapshot bei Erstellung, ChangeLog in derselben Tx (`entity: "INVOICE"`, actions `DUNNING_CREATE`, `DUNNING_SEND`, `DUNNING_STATE`); Mahnungen nach Erstellung unveränderlich (Guard in `src/lib/db.ts` für `dunning`: update nur `sentAt`/`pdfPath`, delete verboten).
- Geld Integer-Cent; Zinsen taggenau via `computeDunning` (unverändert).
- Zod an jeder Boundary; Routen, MCP, Formulare nutzen dieselben Domain-Funktionen.
- Migrationen SQLite UND Postgres (Schemadateien identisch bis auf provider); Backfill Altmahnungen mit Snapshot-Herkunft MIGRATION; Tabellen danach 32 (DunningSettings, SchedulerRun).
- Scheduler-Jobs strikt seriell (ChangeLog `@@unique([orgId, prevHash])`); jeder Lauf protokolliert.
- Auto-Erstellung Default AN, Auto-Versand Default AUS (§26), Versand nur wenn global UND je Stufe aktiv.
- Mahnkosten (`feeCents`) nur auf Stufen mit `order ≥ 2` (COMPLIANCE §12), 40-€-Pauschale nur B2B, einmal je Rechnung; Zinsen nur wenn Stufe `calculateInterest`.
- Testjahre: 2045 dunning-stages, 2046 dunning-engine, 2047 scheduler, 2048 dunning-routes/overview, 2049 mcp-dunning. Bestehende Tests: `phase1.test.ts` Zählung → `toBeGreaterThanOrEqual(4)`, `gobd.test.ts` Level-4-Erwartung wird an die neue Stufenlogik angepasst (Stufe existiert nicht → DunningError „Keine weitere Mahnstufe konfiguriert").
- Prüfkette vor jedem Commit-Abschluss: typecheck, lint, test, build, validate:erechnung; Task 5 zusätzlich Postgres-Skript. Alles im Vordergrund.

---

### Task 1: Schema, Migrationen, Zod, Stufen- und Settings-Domain
**Files:** Modify `prisma/schema.prisma`, `prisma/schema.postgres.prisma`, `src/schemas/index.ts`, `src/domain/masterdata/ensure.ts`, `src/lib/db.ts`; Create `prisma/migrations/<ts>_phase6_dunning/migration.sql` (+ Postgres), `src/domain/dunning/stages.ts`, `src/domain/dunning/settings.ts`; Test `test/unit/dunning-schemas.test.ts`, `test/integration/dunning-stages.test.ts`.
**Schema:**
- `DunningStage` += `autoSend Boolean @default(false)`.
- `Dunning` += `sellerSnapshotJson String?`, `buyerSnapshotJson String?`, `snapshotSource String?` (CREATE|MIGRATION), `claimBaseCents Int @default(0)`, `feeCents Int @default(0)` (= Mahnkosten der Stufe; `lateFeeCents` bleibt für konkrete Zusatzkosten), `invoiceNumber String?`, `invoiceDueDate DateTime?`, `createdBy String @default("user")` (user|scheduler|mcp|api), `@@unique([invoiceId, stageId])`.
- `Invoice` += `dunningState String @default("ACTIVE")`, `dunningPausedUntil DateTime?`, `dunningStateNote String?`.
- Neu `DunningSettings { id, orgId @unique, org, autoCreate Boolean @default(true), autoSend Boolean @default(false), baseInterestRateBp Int @default(127), baseRateValidFrom DateTime?, gracePeriodDays Int @default(0), createdAt, updatedAt }`.
- Neu `SchedulerRun { id, job String, trigger String, status String, startedAt DateTime @default(now()), finishedAt DateTime?, summaryJson String?, error String?, @@index([job, startedAt]) }`.
- Backfill in der Migration: Altmahnungen bekommen `claimBaseCents = grossTotalCents − paidAmountCents` der Rechnung zum Migrationszeitpunkt? NEIN — Beträge sind nicht rekonstruierbar; Ruling: `claimBaseCents` bleibt 0 für Altmahnungen, PDF fällt bei `snapshotSource == null` auf Live-Berechnung mit `payableBaseCents` zurück (Task 2). Snapshots für Altmahnungen per `ensureDunningSnapshots(orgId)` (Selbstheilung, Herkunft MIGRATION) beim ersten Laden — kein SQL-JSON-Bau in der Migration.
**Zod:** `dunningStageInputSchema` {name 1..80, daysAfterDue int ≥0, newDueDays int 1..365, feeCents int ≥0, calculateInterest, includeB2BFlatFee, emailTemplateId nullable, autoSend, enabled} + `superRefine`: feeCents>0 nur bei order ≥ 2 (order kommt aus dem Kontext: create hängt an, update kennt order); `dunningStagesReorderSchema` {ids: string[] min 1}; `dunningSettingsInputSchema` {autoCreate, autoSend, baseInterestRateBp int 0..2000, baseRateValidFrom ISO date nullable, gracePeriodDays 0..90}; `dunningStateInputSchema` {state: ACTIVE|PAUSED|STOPPED, pausedUntil ISO date nullable (nur bei PAUSED), note max 500}.
**Domain `stages.ts`:** `listDunningStages(orgId)`, `createDunningStage(orgId, input)` (order = max+1), `updateDunningStage(orgId, id, input)`, `deleteDunningStage(orgId, id)` (409 `DunningStageInUseError` wenn Mahnungen verknüpft → stattdessen `enabled=false`), `reorderDunningStages(orgId, ids)` (alle Ids der Org, in einer Tx: erst order auf −(i+1), dann i — wegen Unique), `nextEnabledStage(orgId, afterOrder: number | null)`. Alle Schreibvorgänge → ActivityLog? NEIN (Stammdaten) — kein ChangeLog.
**Domain `settings.ts`:** `loadDunningSettings(orgId)` (Selbstheilung: create mit Defaults), `saveDunningSettings(orgId, raw)`.
**db.ts Guard:** `dunning.update/updateMany` nur mit `data`-Schlüsseln ⊆ {sentAt, pdfPath}; `delete/deleteMany` verboten (wie finalInvoiceDeduction).
**Tests:** Zod-Grenzen (feeCents auf order 0/1 → Fehler, order 2 ok), reorder mit 6 Stufen, delete in use → Fehler, disabled übersprungen in `nextEnabledStage`, settings Selbstheilung, Guard wirft bei dunning.delete.
- [ ] Schema + beide Migrationen (SQLite via `prisma migrate dev --name phase6_dunning`, Postgres via Skript) · [ ] Zod + Tests · [ ] stages/settings + Tests · [ ] Guard + Test · [ ] Prüfkette · [ ] Commit `feat(dunning): Schema, Zod, Stufen- und Einstellungs-Domain`

### Task 2: Mahn-Engine (Zeitplan, Erstellung aus Stufe, Snapshot, Status, Versand, PDF)
**Files:** Create `src/domain/dunning/schedule.ts`, `snapshot.ts`, `state.ts`, `send.ts`; Modify `src/domain/dunning/create.ts`, `src/lib/dunning.ts` (nur Titel-Map → aus Stufe), `src/lib/pdf/dunning-data.ts`, `src/domain/email/compose.ts` (`pickDunningTemplate` → `stage.emailTemplateId`, Fallback Name, Fallback Default), `src/domain/email/context.ts` (Kontext `dunning.stageName`, `dunning.fee`, `invoice.openAmount` = claimBase); Test `test/integration/dunning-engine.test.ts`, `test/unit/dunning-schedule.test.ts`; Anpassung `gobd.test.ts` Zeile 285, `phase1.test.ts` Zeilen 77/99.
**Interfaces (Produces):**
```ts
// schedule.ts (rein)
export interface DunningScheduleInput { invoiceDueDate: Date; lastDunning: { order: number; dueDate: Date | null; sentAt: Date } | null; stages: StageLike[]; gracePeriodDays: number; now: Date }
export interface DunningSchedule { nextStage: StageLike | null; dueAt: Date | null; isDue: boolean; daysOverdue: number }
export function dunningScheduleFor(input: DunningScheduleInput): DunningSchedule
//   nextStage = erste enabled Stufe mit order > (lastDunning?.order ?? -1); Basis = lastDunning ? (lastDunning.dueDate ?? lastDunning.sentAt) : invoiceDueDate; dueAt = Basis + daysAfterDue (+ gracePeriodDays nur bei Stufe 0); isDue = now ≥ dueAt (Tagesgenau, UTC-Datum).
// create.ts
export interface DunningOptions { actor?: string; now?: Date; lateFeeCents?: number; force?: boolean /* manuell vor Fälligkeit */; createdBy?: "user"|"scheduler"|"mcp"|"api" }
export async function createDunning(invoiceId: string, opts?: DunningOptions): Promise<{ dunning; openAmountCents; totalCents; daysOverdue; stage }>
//   Regeln: Typ/Status wie bisher; dunningState muss ACTIVE sein (PAUSED mit abgelaufenem pausedUntil wird in derselben Tx auf ACTIVE gesetzt, STOPPED → DunningError); Stufe = nextEnabledStage; keine Stufe → DunningError("Keine weitere Mahnstufe konfiguriert."); !isDue && !force → DunningError("Nächste Mahnstufe erst ab <Datum> fällig."); Geld: interest nur wenn stage.calculateInterest (Basiszins aus DunningSettings), flatFee nur stage.includeB2BFlatFee && B2B && noch nie, feeCents = stage.feeCents (order≥2), lateFeeCents nur wenn order≥2; dueDate = now + stage.newDueDays; Snapshot (seller/buyer wie Invoice-Snapshot-Builder aus src/domain/document/snapshot-input.ts, claimBaseCents, invoiceNumber, invoiceDueDate, snapshotSource CREATE); ChangeLog action DUNNING_CREATE diff {number, stage: name, order, claimBaseCents, interestCents, flatFee40Cents, feeCents, createdBy}.
// state.ts
export async function setDunningState(orgId: string, invoiceId: string, raw: unknown, actor: string): Promise<{ state; pausedUntil }>  // ChangeLog DUNNING_STATE
// send.ts
export async function sendDunning(orgId: string, dunningId: string, opts: { actor: string; to?: string; provider?: MailProvider }): Promise<SendDocumentEmailResult>
//   nutzt sendDocumentEmail(orgId, actor, { docType: "DUNNING", docId, templateId: stage.emailTemplateId ?? prefill }, []); setzt Dunning.sentAt (erlaubter Guard-Pfad) nur bei Erfolg; ChangeLog DUNNING_SEND.
// snapshot.ts
export async function ensureDunningSnapshots(orgId: string): Promise<number>  // Altmahnungen ohne snapshotSource → MIGRATION aus heutigem Stamm
```
**PDF:** `buildDunningPdfData` liest seller/buyer/claimBase aus Snapshot; ohne Snapshot (nie nach ensure) Fallback Live mit `payableBaseCents − paidAmountCents`; Titel aus `stage.name` (Fallback `DUNNING_LEVEL_TITLE[level]`), Zeile „Mahnkosten" für feeCents.
**Tests (§54):** B2C 5 Pp ohne Pauschale; B2B 9 Pp + 40 € nur einmal; 1.000 €/400 € bezahlt → Basis 600 €, Zinsen auf 600; 6 Stufen mit deaktivierter 3. Stufe → übersprungen; Stufe nicht fällig → Fehler, `force` → ok; PAUSED → Fehler, abgelaufen → wieder ACTIVE und Mahnung; STOPPED → Fehler; PAID/CANCELLED → Fehler; Mahnkosten auf Stufe 0/1 = 0 trotz lateFeeCents; Snapshot friert Kundennamen (Umbenennung nach Mahnung ändert PDF-Daten nicht); `sendDunning` mit MemoryMailProvider → EmailLog + sentAt, Vorlage aus stage.emailTemplateId; Guard: `dunning.update({interestAmountCents})` wirft.
- [ ] schedule.ts + Unit-Tests · [ ] create.ts umbauen + Tests · [ ] state.ts, send.ts, snapshot.ts + Tests · [ ] PDF/Compose/Context · [ ] Alttests anpassen (nur die zwei genannten Stellen) · [ ] Prüfkette · [ ] Commits

### Task 3: Scheduler-Runner, Jobs, Instrumentation, Cron-Routen, Script, Auto-Versand
**Files:** Create `src/domain/scheduler/runner.ts`, `src/domain/scheduler/jobs.ts`, `src/domain/dunning/auto.ts`, `src/instrumentation.ts`, `scripts/run-dunning.ts`, `src/app/api/cron/run-dunning/route.ts`, `src/app/api/cron/run-all/route.ts`, `src/app/api/scheduler/run/route.ts` (Session-Auth, manuell), `src/app/api/scheduler/runs/route.ts` (GET letzte 50); Modify `package.json` (`dunning:run`, `scheduler:run`), `.env.example` (`SCHEDULER_ENABLED`, `SCHEDULER_INTERVAL_MINUTES`, `CRON_SECRET`), `docker-compose.yml` nur Doku-Kommentar; Test `test/integration/scheduler.test.ts`.
**Interfaces:**
```ts
// runner.ts
export type SchedulerJob = "dunning" | "recurring";
export interface JobResult { job: SchedulerJob; ok: boolean; summary: Record<string, unknown>; error?: string }
export async function runScheduledJobs(opts: { jobs?: SchedulerJob[]; trigger: "SCHEDULER"|"CRON"|"MANUAL"; now?: Date }): Promise<JobResult[]>
//   je Job: Lock = SchedulerRun RUNNING mit startedAt > now−30min → Job überspringen (summary {skipped:"locked"}); stale RUNNING → auf FAILED("stale") setzen und weiter; Eintrag anlegen, Job ausführen, Eintrag abschließen (OK/FAILED + summaryJson/error). Jobs seriell in fester Reihenfolge recurring → dunning. Fehler eines Jobs bricht die anderen nicht ab.
// jobs.ts: registriert { recurring: () => runDueRecurring(), dunning: (now) => runDunningJob(now) }
// dunning/auto.ts
export async function runDunningJob(now = new Date()): Promise<{ orgs: number; checked: number; created: string[]; sent: string[]; skipped: Record<string, number>; errors: { invoiceId: string; message: string }[] }>
//   je Org mit settings.autoCreate: Kandidaten = Rechnungen Typ ∈ DUNNABLE, Status ∈ {FINALIZED, SENT, PARTIALLY_PAID}, dunningState ≠ STOPPED, offen > 0 (payableBaseCents − paid); je Kandidat dunningScheduleFor → isDue → createDunning(id, {actor:"scheduler", createdBy:"scheduler", now}); danach wenn settings.autoSend && stage.autoSend → sendDunning (Fehler → errors[], Lauf geht weiter). Seriell (for-await), keine Promise.all.
// instrumentation.ts
export async function register() { if (process.env.NEXT_RUNTIME !== "nodejs") return; if (process.env.SCHEDULER_ENABLED === "false") return; const minutes = Number(process.env.SCHEDULER_INTERVAL_MINUTES ?? 15); const { startScheduler } = await import("./domain/scheduler/loop"); startScheduler(minutes); }
// scheduler/loop.ts: startScheduler(minutes) — globalThis-Singleton (HMR-sicher), erster Lauf nach 60 s, dann setInterval; unhandled → console.error; nie zwei Läufe gleichzeitig (in-process Flag zusätzlich zum DB-Lock).
```
Cron-Routen kopieren das `authorized()`-Muster von run-recurring; `run-all` ruft `runScheduledJobs({trigger:"CRON"})`, `run-dunning` nur Job dunning. `/api/scheduler/run` (POST, Session) → MANUAL. Bestehende `run-recurring`-Route bleibt (ruft künftig `runScheduledJobs({jobs:["recurring"], trigger:"CRON"})`, damit auch sie protokolliert wird).
**Tests:** zwei Rechnungen fällig/nicht fällig → genau eine Mahnung; zweiter Lauf am selben Tag → 0 neue; PAUSED übersprungen; STOPPED übersprungen; autoSend global aus → sentAt unverändert; global+Stufe an → EmailLog (MemoryMailProvider injizierbar über `runDunningJob(now, {provider})`); Mailfehler → errors[] aber created[] voll; Lock: RUNNING-Eintrag jung → skipped:"locked", alt → stale + Lauf; SchedulerRun-Einträge OK/FAILED; Cron-Route 401 ohne Secret wenn gesetzt.
- [ ] runner + Tests · [ ] auto.ts + Tests · [ ] loop/instrumentation (Unit: Singleton) · [ ] Routen/Script/env · [ ] Prüfkette · [ ] Commits

### Task 4: UI (/mahnwesen, Einstellungen → Mahnwesen/Automatisierung, Rechnungsseite), Routen, MCP
**Files:** Create `src/domain/dunning/overview.ts`, `src/app/mahnwesen/page.tsx`, `src/components/dunning/{OverviewWidgets,OverdueTable,DunningActions,PauseDialog}.tsx`, `src/app/einstellungen/mahnwesen/page.tsx` (+ `DunningStagesEditor.tsx`, `DunningSettingsForm.tsx`), `src/app/einstellungen/automatisierung/page.tsx` (+ `SchedulerRunsTable.tsx`), Routen `src/app/api/dunning-stages/route.ts` (GET/POST), `[id]/route.ts` (PATCH/DELETE), `reorder/route.ts` (POST), `src/app/api/dunning-settings/route.ts` (GET/PUT), `src/app/api/dunnings/[id]/send/route.ts` (POST), `src/app/api/invoices/[id]/dunning-state/route.ts` (POST), `src/app/api/dunning/overview/route.ts` (GET); Modify `src/app/api/invoices/[id]/dunning/route.ts` (Body `{force?, lateFeeCents?}`, 409 statt 422 bei DunningError, Zod), `src/app/rechnungen/[id]/page.tsx` (Mahnblock: Status, nächste Stufe/Datum, Aktionen; `DunningButton` entfernen), `src/components/SettingsTabs.tsx` (+ Mahnwesen, Automatisierung), Navigation (+ Mahnwesen), `src/mcp/server.ts`; Test `test/integration/dunning-routes.test.ts`, `test/integration/mcp-dunning.test.ts`.
**overview.ts:** `loadDunningOverview(orgId, now)` → `{ widgets: { overdueCount, openTotalCents, aging: {d1_7, d8_30, d31_60, d60plus} (jeweils {count, cents}) }, rows: [{ invoiceId, number, customerName, grossCents, paidCents, openCents, dueDate, daysOverdue, currentStage: {name, order} | null, nextStage, nextDunningAt, dunningState, pausedUntil, lastContactAt (max EmailLog.sentAt der Rechnung/ihrer Mahnungen) }] }` — sortiert nach daysOverdue desc; Filter `{ customerId?, state?, stageOrder? }`.
**Aktionen je Zeile/Rechnungsseite:** Zahlung erfassen (bestehendes PaymentForm), Erinnerung/nächste Mahnung erstellen (POST dunning, bei nicht fällig Bestätigung + `force`), Mahnung senden (SendEmailDialog mit docType DUNNING vorbelegt, Vorlage der Stufe), pausieren (Dialog Datum + Notiz), beenden, fortsetzen. Alle mit Backend.
**MCP:** `create_dunning` (Param force), `send_dunning {dunning}`, `set_dunning_state {invoice, state, pausedUntil?, note?}`, `list_overdue_invoices {state?}`, `run_scheduler_job {job}` — dieselben Zod/Domain-Funktionen.
**Tests:** Routen 200/400/404/409 (Stage CRUD inkl. feeCents-Regel, reorder, delete in use, settings PUT, dunning-state, send mit MemoryMailProvider? → Route nutzt Provider aus Settings; Test über Domain), overview-Route Aging-Buckets mit 4 Rechnungen (3, 20, 45, 90 Tage), MCP-Tools inkl. Fehlerpfade.
- [ ] overview.ts + Tests · [ ] Routen + Tests · [ ] Seiten/Komponenten · [ ] Rechnungsseite/Nav/Tabs · [ ] MCP + Tests · [ ] Prüfkette (build!) · [ ] Commits

### Task 5: Postgres-Skript, Doku, Compose/Betrieb, Restfälle
**Files:** `scripts/test-postgres-migrations.sh` (Tabellen 32, Phase-6-Migration, Fall 8: DunningStage.autoSend Default false, DunningSettings Selbstheilung nicht per SQL → Existenz der Tabelle, Unique `[invoiceId, stageId]`), `COMPLIANCE.md` §12 (Stufen-getriebene Logik, Mahnkosten ab 2. Mahnung erzwungen, Basiszins-Pflege mit gültig-ab, Quellen), `docs/LIMITATIONEN.md` (Scheduler single-instance, Basiszins-Historie fehlt, Auto-Versand-Default, Altmahnungen ohne Beträge-Snapshot), `docs/ARCHITEKTUR.md` (Mahn-Engine, Runner, Instrumentation), `docs/ANLEITUNG.md` (Cron-Alternative für dunning/run-all), `README*.md` (Scheduler nicht mehr Roadmap), `docs/MCP.md` (5 Tools), `.env.example`, `docker-compose.yml`-Kommentar (`SCHEDULER_ENABLED`), BETRIEB-Hinweis nur in der lokalen Serverdoku (nicht im Repo).
- [ ] Postgres-Skript + Lauf · [ ] Doku · [ ] Prüfkette komplett · [ ] Commit `docs(dunning): Phase 6 dokumentiert`
