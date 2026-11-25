/**
 * Automatischer Versand von Abo-Rechnungen (Outbox `InvoiceAutoSend`) mit Wiederholung.
 *
 * Regeln (Rulings R22c-2/3/6):
 * - Der Versandauftrag entsteht in DERSELBEN Transaktion wie die festgeschriebene Rechnung
 *   (`enqueueAutoSendWithinTx`); die Rechnung selbst wird hier nie geaendert.
 * - Wiederholt wird nur, wenn die Mail SICHER nicht angenommen wurde (`NOT_SENT`). Unklarer Ausgang
 *   (Zeitueberschreitung nach DATA, Absturz, Protokoll QUEUED) = `UNCLEAR`: kein automatischer Versuch,
 *   der Bediener entscheidet (`retryAutoSend` mit Bestaetigung, die Mail kann doppelt ankommen).
 * - Ohne Empfaenger wartet der Auftrag bis 7 Tage (Pruefung alle 6 h), danach `GAVE_UP`.
 * - Wurde die Rechnung inzwischen manuell versendet (EmailLog SENT/QUEUED eines anderen Akteurs),
 *   versendet die Automatik nie mehr (`DONE_MANUAL`).
 * - Bestand wird nicht nachversendet: die Tabelle startet leer, Auftraege entstehen nur aus Laeufen.
 * - Doppelversand ausgeschlossen durch Claim (`updateMany` mit Status + Faelligkeit) mit echtem Zeitstempel und
 *   Claim-Token; `settle`/`resolveStale` wirken nur bei passendem Token (ein ueberholter Lauf aendert nichts).
 *   Keine SMTP-Aufrufe in einer Transaktion; haengende `SENDING`-Zeilen werden anhand des EmailLog aufgeloest,
 *   nie blind wiederholt (vorhandenes Protokoll -> UNCLEAR).
 * - Automatik und manueller Versand schliessen sich atomar aus (`acquireManualSendLock`, auto-send-guard.ts): der manuelle
 *   Versand sperrt die Zeile (PENDING/RETRY/NO_ADDRESS -> MANUAL_PENDING) unmittelbar vor dem QUEUED-Protokoll und lehnt bei
 *   SENDING ab; der Claim der Automatik scheitert an MANUAL_PENDING. Nach dem Versuch: SENT -> DONE_MANUAL, sonst zurueck in
 *   den vorherigen Zustand. Ein abgestuerzter manueller Versand (MANUAL_PENDING > 30 min) wird anhand des Protokolls aufgeloest.
 *   Bleibt ein Restfenster (manuell, waehrend die Zeile in einem Endzustand/ohne Zeile ist), sieht der Bediener beide Protokolle.
 * - Pflicht-Benachrichtigung (NO_ADDRESS/UNCLEAR/GAVE_UP) in derselben Transaktion wie der Statuswechsel; der Job
 *   holt Verpasstes nach (`notifiedStatus`), je Neustart-Zyklus (`cycle`) eigener Schluessel.
 * - Meldungen nach aussen nur mit festem Code (nie Servertext).
 */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import type { MailProvider } from "@/lib/mail/provider";
import { logActivity } from "@/domain/activity/log";
import { notifyRecurringNotSentWithinTx } from "@/domain/notifications/hooks";
import { AUTO_SEND_ACTOR } from "./auto-send-guard";
import { sendRecurringInvoiceEmail } from "./run-parts";

export type AutoSendStatus = "PENDING" | "SENDING" | "RETRY" | "NO_ADDRESS" | "SENT" | "UNCLEAR" | "GAVE_UP" | "DONE_MANUAL" | "CANCELLED" | "BOUNCED" | "MANUAL_PENDING";
export type AutoSendCode = "SMTP_REJECTED" | "MAIL_NOT_CONFIGURED" | "PREPARE_FAILED" | "NO_ADDRESS" | "NOT_FINAL" | "UNCLEAR_OUTCOME";

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
/** Wartezeiten nach dem 1., 2., 3. fehlgeschlagenen Versuch; nach dem 4. wird aufgegeben. */
const BACKOFF_MS = [15 * MIN_MS, HOUR_MS, 4 * HOUR_MS] as const;
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const NO_ADDRESS_RECHECK_MS = 6 * HOUR_MS;
const NO_ADDRESS_LIMIT_MS = 7 * DAY_MS;
const STALE_SENDING_MS = 30 * MIN_MS;
const JOB_BATCH = 200;

export interface AutoSendState {
  status: AutoSendStatus;
  /** Anzahl Versuche INKLUSIVE des gerade beendeten. */
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export type AttemptResult =
  | { kind: "SENT" }
  | { kind: "NOT_SENT"; code: "SMTP_REJECTED" | "MAIL_NOT_CONFIGURED" | "PREPARE_FAILED" }
  | { kind: "UNKNOWN" }
  | { kind: "NO_ADDRESS" };

/** Rein: naechster Zustand nach einem Versuch. */
export function nextStep(state: AutoSendState, result: AttemptResult, now: Date): AutoSendState {
  switch (result.kind) {
    case "SENT":
      return { ...state, status: "SENT", nextAttemptAt: null, lastError: null };
    case "UNKNOWN":
      return { ...state, status: "UNCLEAR", nextAttemptAt: null, lastError: "UNCLEAR_OUTCOME" };
    case "NO_ADDRESS": {
      // Das Warten auf eine Adresse zaehlt nicht als Versandversuch.
      const attempts = Math.max(0, state.attempts - 1);
      if (now.getTime() >= state.createdAt.getTime() + NO_ADDRESS_LIMIT_MS) {
        return { ...state, status: "GAVE_UP", attempts, nextAttemptAt: null, lastError: "NO_ADDRESS" };
      }
      return { ...state, status: "NO_ADDRESS", attempts, nextAttemptAt: new Date(now.getTime() + NO_ADDRESS_RECHECK_MS), lastError: "NO_ADDRESS" };
    }
    case "NOT_SENT": {
      const wait = BACKOFF_MS[state.attempts - 1];
      if (state.attempts >= MAX_ATTEMPTS || wait === undefined) {
        return { ...state, status: "GAVE_UP", nextAttemptAt: null, lastError: result.code };
      }
      return { ...state, status: "RETRY", nextAttemptAt: new Date(now.getTime() + wait), lastError: result.code };
    }
  }
}

/** Legt den Versandauftrag an (Aufrufer: Abo-Lauf, in der Transaktion der festgeschriebenen Rechnung). */
export async function enqueueAutoSendWithinTx(
  tx: Prisma.TransactionClient,
  i: { orgId: string; invoiceId: string; recurringId: string | null; now: Date },
): Promise<void> {
  await tx.invoiceAutoSend.create({
    data: { orgId: i.orgId, invoiceId: i.invoiceId, recurringId: i.recurringId, status: "PENDING", nextAttemptAt: i.now, createdAt: i.now },
    select: { id: true },
  });
}

export interface AutoSendOutcome {
  /** `NOT_CLAIMED`: nichts getan (Zeile fehlt, anderer Lauf hat sie, noch nicht faellig, Endzustand). */
  status: AutoSendStatus | "NOT_CLAIMED";
  code?: string;
}

const AUTO_ROW = {
  id: true,
  orgId: true,
  invoiceId: true,
  recurringId: true,
  status: true,
  attempts: true,
  createdAt: true,
  claimedAt: true,
  emailLogId: true,
  claimToken: true,
  confirmUnclear: true,
  cycle: true,
  notifiedStatus: true,
} as const;

async function loadRow(id: string) {
  return dbInternal.invoiceAutoSend.findUnique({ where: { id }, select: AUTO_ROW });
}

type ProblemStatus = "NO_ADDRESS" | "UNCLEAR" | "GAVE_UP" | "BOUNCED";
const isProblem = (s: string): s is ProblemStatus => s === "NO_ADDRESS" || s === "UNCLEAR" || s === "GAVE_UP" || s === "BOUNCED";

/**
 * Pflicht-Benachrichtigung + Aktivitaet fuer einen Problemzustand, in der Transaktion des Statuswechsels.
 * Einmal je Zustand und Zyklus (`notifiedStatus`); wiederholte NO_ADDRESS-Pruefungen melden nicht erneut.
 */
async function reportWithinTx(
  tx: Prisma.TransactionClient,
  rowId: string,
  status: string,
  code: string | null,
  at: Date,
): Promise<void> {
  if (!isProblem(status)) return;
  const row = await tx.invoiceAutoSend.findUnique({ where: { id: rowId }, select: { orgId: true, invoiceId: true, attempts: true, cycle: true, notifiedStatus: true } });
  if (!row || row.notifiedStatus === status) return;
  const invoice = await tx.invoice.findFirst({ where: { id: row.invoiceId, orgId: row.orgId }, select: { number: true } });
  await logActivity(tx, {
    orgId: row.orgId,
    entityType: "INVOICE",
    entityId: row.invoiceId,
    type: "AUTO_SEND_PROBLEM",
    actor: AUTO_SEND_ACTOR,
    at,
    data: { status, code, attempts: row.attempts },
  });
  await notifyRecurringNotSentWithinTx(tx, row.orgId, { invoiceId: row.invoiceId, number: invoice?.number ?? null, status, cycle: row.cycle, at });
  await tx.invoiceAutoSend.update({ where: { id: rowId }, data: { notifiedStatus: status }, select: { id: true } });
}

/**
 * Statuswechsel einer geclaimten Zeile: nur wenn sie noch SENDING ist UND das Token passt (sonst hat ein anderer Lauf
 * uebernommen und nichts wird geaendert). Problemzustaende werden in derselben Transaktion gemeldet.
 * Liefert `false`, wenn der Claim verloren war.
 */
async function transition(
  where: { id: string; claimToken: string | null; claimedAt?: Date | null },
  data: { status: AutoSendStatus; attempts?: number; nextAttemptAt: Date; lastError: string | null; emailLogId?: string },
  now: Date,
): Promise<boolean> {
  return dbInternal.$transaction(async (tx) => {
    const upd = await tx.invoiceAutoSend.updateMany({
      where: { id: where.id, status: "SENDING", claimToken: where.claimToken, ...(where.claimedAt ? { claimedAt: where.claimedAt } : {}) },
      // Der bestaetigte Versuch ist beendet: die Bestaetigung (`confirmUnclear`) gilt nicht weiter.
      data: { ...data, claimToken: null, confirmUnclear: false },
    });
    if (upd.count === 0) return false;
    await reportWithinTx(tx, where.id, data.status, data.lastError, now);
    return true;
  });
}

/** Beendet eine geclaimte Zeile; das Ergebnis stammt aus dem tatsaechlichen Zustand (bei verlorenem Claim der aktuelle). */
async function settle(
  row: { id: string; claimToken: string | null },
  next: AutoSendState,
  now: Date,
  extra: { emailLogId?: string } = {},
): Promise<AutoSendOutcome> {
  const ok = await transition(
    { id: row.id, claimToken: row.claimToken },
    {
      status: next.status,
      attempts: next.attempts,
      nextAttemptAt: next.nextAttemptAt ?? new Date(now.getTime()),
      lastError: next.lastError,
      ...(extra.emailLogId ? { emailLogId: extra.emailLogId } : {}),
    },
    now,
  );
  if (ok) return { status: next.status, ...(next.lastError ? { code: next.lastError } : {}) };
  const cur = await loadRow(row.id);
  return { status: cur ? (cur.status as AutoSendStatus) : "NOT_CLAIMED" };
}

async function startedLogsSince(orgId: string, invoiceId: string, since: Date) {
  return dbInternal.emailLog.findMany({
    where: { orgId, docType: "INVOICE", docId: invoiceId, createdAt: { gte: since } },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Ein Versandversuch fuer eine Zeile. Seriell, kein SMTP in einer Transaktion.
 * Claim: nur PENDING/RETRY/NO_ADDRESS mit faelliger `nextAttemptAt`; parallele Aufrufer scheitern am Claim.
 */
export async function dispatchAutoSend(id: string, now: Date, provider?: MailProvider): Promise<AutoSendOutcome> {
  // `nextAttemptAt <= now` nutzt die Planungszeit des Aufrufers; `claimedAt` ist die echte Uhr (Beginn des Versuchs),
  // damit ein langer Lauf nicht als haengend gilt, nur weil sein Start-`now` alt ist.
  const claimToken = randomUUID();
  const claim = await dbInternal.invoiceAutoSend.updateMany({
    where: { id, status: { in: ["PENDING", "RETRY", "NO_ADDRESS"] }, nextAttemptAt: { lte: now } },
    data: { status: "SENDING", claimedAt: new Date(), claimToken, attempts: { increment: 1 } },
  });
  if (claim.count === 0) return { status: "NOT_CLAIMED" };
  // Nach dem Claim laden: `attempts` ist der echte Stand, das Token weist den Besitz nach.
  const row = await loadRow(id);
  if (!row || row.claimToken !== claimToken) return { status: "NOT_CLAIMED" };
  const state = (): AutoSendState => ({ status: "SENDING", attempts: row.attempts, nextAttemptAt: null, lastError: null, createdAt: row.createdAt });
  const finish = (to: AutoSendStatus, code: string | null, extra: { emailLogId?: string } = {}) =>
    settle(row, { ...state(), status: to, lastError: code, nextAttemptAt: null }, now, extra);

  // Vorpruefung: Beleg und bereits vorhandener Versand.
  const invoice = await dbInternal.invoice.findFirst({ where: { id: row.invoiceId, orgId: row.orgId }, select: { status: true, number: true } });
  if (!invoice) return finish("GAVE_UP", "NOT_FINAL");
  if (invoice.status === "CANCELLED") return finish("CANCELLED", null);
  // Manueller Versand (anderer Akteur als die Automatik) stoppt die Automatik; Protokolle der Automatik selbst zaehlen nicht.
  // Nach bestaetigtem Neustart (`confirmUnclear`) blockiert ein QUEUED-Protokoll (abgestuerzter manueller Versand) nicht mehr.
  const manual = await dbInternal.emailLog.findFirst({
    where: {
      orgId: row.orgId,
      docType: "INVOICE",
      docId: row.invoiceId,
      status: { in: row.confirmUnclear ? ["SENT"] : ["SENT", "QUEUED"] },
      OR: [{ sentByUserId: null }, { sentByUserId: { not: AUTO_SEND_ACTOR } }],
    },
    select: { status: true },
    orderBy: { createdAt: "asc" },
  });
  if (manual) return manual.status === "SENT" ? finish("DONE_MANUAL", null) : finish("UNCLEAR", "UNCLEAR_OUTCOME");
  if (invoice.status === "DRAFT" || invoice.number == null) return finish("GAVE_UP", "NOT_FINAL");

  const rec = row.recurringId
    ? await dbInternal.recurringInvoice.findFirst({ where: { id: row.recurringId, orgId: row.orgId }, select: { emailTemplateId: true } })
    : null;
  // Protokolle VOR dem Versuch merken: nach einer Ausnahme zaehlt jedes neue Protokoll als "Versand begonnen"
  // (unabhaengig von Uhr und Testdatum).
  const known = new Set((await dbInternal.emailLog.findMany({ where: { orgId: row.orgId, docType: "INVOICE", docId: row.invoiceId }, select: { id: true } })).map((l) => l.id));
  // Besitz unmittelbar vor dem Versand bestaetigen und `claimedAt` erneuern: hat ein anderer Lauf die Zeile als haengend
  // uebernommen (z. B. nach sehr langer Vorbereitung), wird hier nicht mehr gesendet. Der SMTP-Versuch selbst ist durch
  // die Zeitlimits des Transports auf wenige Minuten begrenzt und liegt damit weit unter der Haenge-Schwelle.
  const stillOwned = await dbInternal.invoiceAutoSend.updateMany({
    where: { id: row.id, status: "SENDING", claimToken },
    data: { claimedAt: new Date() },
  });
  if (stillOwned.count === 0) return { status: "NOT_CLAIMED" };
  const attempt = await sendRecurringInvoiceEmail(row.orgId, row.invoiceId, provider, rec?.emailTemplateId ?? null);

  let result: AttemptResult;
  let logId: string | undefined;
  switch (attempt.status) {
    case "SENT":
      result = { kind: "SENT" };
      logId = attempt.logId;
      break;
    case "SKIPPED":
      result = { kind: "NO_ADDRESS" };
      break;
    case "FAILED":
      result = attempt.outcome === "NOT_SENT" ? { kind: "NOT_SENT", code: "SMTP_REJECTED" } : { kind: "UNKNOWN" };
      break;
    case "THROWN": {
      // Eine Ausnahme nach dem Anlegen des Protokolls ist unklar (Mail koennte raus sein); ohne Protokoll ist nichts versendet.
      const logs = (await dbInternal.emailLog.findMany({ where: { orgId: row.orgId, docType: "INVOICE", docId: row.invoiceId }, select: { id: true, status: true } })).filter((l) => !known.has(l.id));
      const sent = logs.find((l) => l.status === "SENT");
      if (sent) {
        result = { kind: "SENT" };
        logId = sent.id;
      } else if (logs.length > 0) {
        result = { kind: "UNKNOWN" };
      } else {
        result = { kind: "NOT_SENT", code: attempt.mailNotConfigured ? "MAIL_NOT_CONFIGURED" : "PREPARE_FAILED" };
      }
      break;
    }
  }
  return settle(row, nextStep(state(), result, now), now, logId ? { emailLogId: logId } : {});
}

/** `emailStatus` des Abo-Laufs aus dem Ergebnis des ersten Versuchs. */
function toEmailStatus(o: AutoSendOutcome): "SENT" | "FAILED" | "SKIPPED" | "UNCLEAR" {
  switch (o.status) {
    case "SENT":
      return "SENT";
    case "NO_ADDRESS":
    case "DONE_MANUAL":
    case "NOT_CLAIMED": // Besitz verloren oder nicht faellig: in diesem Aufruf wurde nichts gesendet
      return "SKIPPED";
    case "UNCLEAR":
      return "UNCLEAR";
    default:
      return "FAILED";
  }
}

/** Erster Versuch direkt nach dem Abo-Lauf (nach der Transaktion). Wirft nie. */
export async function dispatchAutoSendForInvoice(
  invoiceId: string,
  now: Date,
  provider?: MailProvider,
): Promise<{ emailStatus: "SENT" | "FAILED" | "SKIPPED" | "UNCLEAR"; error?: string }> {
  try {
    const row = await dbInternal.invoiceAutoSend.findUnique({ where: { invoiceId }, select: { id: true } });
    if (!row) return { emailStatus: "SKIPPED" };
    const o = await dispatchAutoSend(row.id, now, provider);
    return { emailStatus: toEmailStatus(o), ...(o.code ? { error: o.code } : {}) };
  } catch (e) {
    console.error("auto-send: Versuch fehlgeschlagen", e instanceof Error ? e.name : "unknown");
    return { emailStatus: "FAILED", error: "PREPARE_FAILED" };
  }
}

export interface AutoSendJobResult {
  checked: number;
  sent: number;
  retry: number;
  unclear: number;
  gaveUp: number;
  waiting: number;
}

/** Loest haengende SENDING-Zeilen anhand des Protokolls auf — nie blind wiederholen. Fehler je Zeile isoliert. */
async function resolveStale(now: Date): Promise<void> {
  const threshold = new Date(now.getTime() - STALE_SENDING_MS);
  const stale = await dbInternal.invoiceAutoSend.findMany({
    where: { status: "SENDING", claimedAt: { lt: threshold } },
    select: { id: true, orgId: true, invoiceId: true, claimedAt: true, claimToken: true },
    take: JOB_BATCH,
  });
  for (const row of stale) {
    if (!row.claimedAt) continue;
    try {
      const logs = await startedLogsSince(row.orgId, row.invoiceId, row.claimedAt);
      const sent = logs.find((l) => l.status === "SENT");
      let data: { status: AutoSendStatus; emailLogId?: string; lastError: string | null; nextAttemptAt: Date };
      if (sent) data = { status: "SENT", emailLogId: sent.id, lastError: null, nextAttemptAt: now };
      else if (logs.length > 0) data = { status: "UNCLEAR", lastError: "UNCLEAR_OUTCOME", nextAttemptAt: now };
      else data = { status: "RETRY", lastError: "PREPARE_FAILED", nextAttemptAt: now };
      // claimedAt im WHERE: hat der Lauf inzwischen erneuert (stillOwned) und sendet, gilt er nicht mehr als haengend.
      await transition({ id: row.id, claimToken: row.claimToken, claimedAt: row.claimedAt }, data, now);
    } catch (e) {
      console.error("auto-send: haengende Zeile nicht aufgeloest", e instanceof Error ? e.name : "unknown");
    }
  }
}

/** Abgestuerzter manueller Versand (MANUAL_PENDING zu lange): Aufloesung anhand des Protokolls, nie blind wiederholen. */
async function resolveStaleManual(now: Date): Promise<void> {
  const threshold = new Date(now.getTime() - STALE_SENDING_MS);
  const stale = await dbInternal.invoiceAutoSend.findMany({
    where: { status: "MANUAL_PENDING", updatedAt: { lt: threshold } },
    select: { id: true, orgId: true, invoiceId: true, updatedAt: true },
    take: JOB_BATCH,
  });
  for (const row of stale) {
    try {
      const logs = await dbInternal.emailLog.findMany({
        where: { orgId: row.orgId, docType: "INVOICE", docId: row.invoiceId },
        select: { status: true, sentByUserId: true, createdAt: true },
      });
      const manual = logs.filter((l) => l.sentByUserId !== AUTO_SEND_ACTOR);
      const status: AutoSendStatus = manual.some((l) => l.status === "SENT") ? "DONE_MANUAL" : manual.some((l) => l.status === "QUEUED") ? "UNCLEAR" : "RETRY";
      await dbInternal.$transaction(async (tx) => {
        const upd = await tx.invoiceAutoSend.updateMany({
          where: { id: row.id, status: "MANUAL_PENDING", updatedAt: row.updatedAt },
          data: { status, nextAttemptAt: now, lastError: status === "UNCLEAR" ? "UNCLEAR_OUTCOME" : null },
        });
        if (upd.count > 0) await reportWithinTx(tx, row.id, status, status === "UNCLEAR" ? "UNCLEAR_OUTCOME" : null, now);
      });
    } catch (e) {
      console.error("auto-send: haengende manuelle Sperre nicht aufgeloest", e instanceof Error ? e.name : "unknown");
    }
  }
}

/**
 * Ein Zustellbericht meldet die versendete Abo-Mail als unzustellbar: SENT -> BOUNCED (wirkt nur auf SENT, idempotent)
 * mit Pflicht-Benachrichtigung in derselben Transaktion. Liefert, ob eine Zeile geaendert wurde.
 */
export async function markAutoSendBounced(orgId: string, emailLogId: string, at: Date): Promise<boolean> {
  return dbInternal.$transaction(async (tx) => {
    const row = await tx.invoiceAutoSend.findFirst({ where: { orgId, emailLogId, status: "SENT" }, select: { id: true } });
    if (!row) return false;
    const upd = await tx.invoiceAutoSend.updateMany({
      where: { id: row.id, status: "SENT" },
      data: { status: "BOUNCED", lastError: "BOUNCED", claimToken: null },
    });
    if (upd.count !== 1) return false;
    await reportWithinTx(tx, row.id, "BOUNCED", "BOUNCED", at);
    return true;
  });
}

/** Holt verpasste Pflicht-Benachrichtigungen nach (Absturz zwischen Statuswechsel und Meldung); idempotent ueber `notifiedStatus`. */
async function sweepUnreported(now: Date): Promise<void> {
  const rows = await dbInternal.invoiceAutoSend.findMany({
    // Nur Zeilen, deren Zustand noch nicht gemeldet ist (terminale, bereits gemeldete Zeilen verdraengen den Sweep nicht).
    where: {
      OR: (["NO_ADDRESS", "UNCLEAR", "GAVE_UP", "BOUNCED"] as const).map((s) => ({ status: s, OR: [{ notifiedStatus: null }, { notifiedStatus: { not: s } }] })),
    },
    select: { id: true, status: true, lastError: true, notifiedStatus: true },
    orderBy: { updatedAt: "asc" },
    take: JOB_BATCH * 5,
  });
  for (const r of rows) {
    if (r.notifiedStatus === r.status) continue;
    try {
      await dbInternal.$transaction(async (tx) => {
        const cur = await tx.invoiceAutoSend.findUnique({ where: { id: r.id }, select: { status: true, lastError: true } });
        if (cur) await reportWithinTx(tx, r.id, cur.status, cur.lastError, now);
      });
    } catch (e) {
      console.error("auto-send: Benachrichtigung nicht nachgeholt", e instanceof Error ? e.name : "unknown");
    }
  }
}

/** Scheduler-Job: haengende Zeilen aufloesen, Verpasstes melden, dann faellige Zeilen seriell versuchen. */
export async function runAutoSendJob(now: Date, provider?: MailProvider): Promise<AutoSendJobResult> {
  const res: AutoSendJobResult = { checked: 0, sent: 0, retry: 0, unclear: 0, gaveUp: 0, waiting: 0 };
  await resolveStale(now);
  await resolveStaleManual(now);
  await sweepUnreported(now);
  const due = await dbInternal.invoiceAutoSend.findMany({
    where: { status: { in: ["PENDING", "RETRY", "NO_ADDRESS"] }, nextAttemptAt: { lte: now } },
    select: { id: true },
    orderBy: { nextAttemptAt: "asc" },
    take: JOB_BATCH,
  });
  for (const r of due) {
    res.checked += 1;
    let o: AutoSendOutcome;
    try {
      o = await dispatchAutoSend(r.id, now, provider);
    } catch (e) {
      console.error("auto-send: Zeile fehlgeschlagen", e instanceof Error ? e.name : "unknown");
      continue;
    }
    if (o.status === "SENT") res.sent += 1;
    else if (o.status === "RETRY") res.retry += 1;
    else if (o.status === "UNCLEAR") res.unclear += 1;
    else if (o.status === "GAVE_UP") res.gaveUp += 1;
    else if (o.status === "NO_ADDRESS") res.waiting += 1;
  }
  return res;
}

/** Feste Codes (REST: 404 bzw. 409 mit `reason`, MCP/UI: fester Text). */
export type AutoSendRetryCode = "NO_AUTO_SEND" | "NOT_RETRYABLE" | "CONFIRM_REQUIRED" | "STATE_CHANGED";

export class AutoSendRetryError extends Error {
  constructor(
    message: string,
    readonly code: AutoSendRetryCode = "NOT_RETRYABLE",
  ) {
    super(message);
    this.name = "AutoSendRetryError";
  }
}

/** Zustaende, aus denen der Bediener den automatischen Versand neu starten darf. */
export const AUTO_SEND_RETRYABLE: readonly AutoSendStatus[] = ["UNCLEAR", "GAVE_UP", "NO_ADDRESS", "BOUNCED"];

/** Ende der Wartezeit auf eine Mailadresse (danach `GAVE_UP`). */
export function noAddressDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + NO_ADDRESS_LIMIT_MS);
}

/**
 * Manueller Neustart (UI/REST). `UNCLEAR` nur mit Bestaetigung (die Mail kann doppelt ankommen).
 * Setzt auf RETRY (Zaehler 0, sofort faellig) und versucht sofort.
 */
export async function retryAutoSend(
  orgId: string,
  invoiceId: string,
  actor: string,
  opts: { confirmUnclear: boolean },
  now: Date = new Date(),
  provider?: MailProvider,
): Promise<AutoSendStatus> {
  const row = await dbInternal.invoiceAutoSend.findFirst({ where: { orgId, invoiceId }, select: { id: true, status: true } });
  if (!row) throw new AutoSendRetryError("Kein automatischer Versand für diese Rechnung.", "NO_AUTO_SEND");
  if (!(AUTO_SEND_RETRYABLE as readonly string[]).includes(row.status)) {
    throw new AutoSendRetryError("Der automatische Versand kann in diesem Zustand nicht neu gestartet werden.", "NOT_RETRYABLE");
  }
  if (row.status === "UNCLEAR" && !opts.confirmUnclear) {
    throw new AutoSendRetryError("Der Ausgang des Versands ist unklar; die E-Mail kann doppelt ankommen. Bitte ausdrücklich bestätigen.", "CONFIRM_REQUIRED");
  }
  const upd = await dbInternal.invoiceAutoSend.updateMany({
    where: { id: row.id, status: row.status },
    data: {
      status: "RETRY",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      claimToken: null,
      cycle: { increment: 1 },
      notifiedStatus: null,
      // Bestaetigter unklarer Ausgang: ein haengendes QUEUED-Protokoll eines manuellen Versands blockiert nicht mehr.
      confirmUnclear: row.status === "UNCLEAR",
    },
  });
  if (upd.count === 0) throw new AutoSendRetryError("Der Zustand hat sich inzwischen geändert.", "STATE_CHANGED");
  await logActivity(dbInternal, {
    orgId,
    entityType: "INVOICE",
    entityId: invoiceId,
    type: "AUTO_SEND_RETRIED",
    actor,
    at: now,
    data: { from: row.status, confirmedUnclear: row.status === "UNCLEAR" },
  });
  const o = await dispatchAutoSend(row.id, now, provider);
  if (o.status !== "NOT_CLAIMED") return o.status;
  const cur = await loadRow(row.id);
  return (cur?.status as AutoSendStatus | undefined) ?? "RETRY";
}
