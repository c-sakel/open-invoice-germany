/**
 * Ausfuehrung faelliger Regel-Laeufe nach dem Commit der Zahlung (Scheduler-Job und Anstoss).
 * Exklusivitaet: ein Lauf wird per bedingtem `updateMany` (Status + Terminfeld wie gelesen) auf RUNNING
 * gesetzt und mit `lockedUntil` (5 Minuten) markiert; nur der Gewinner fuehrt aus. Alle weiteren
 * Schreibzugriffe des Laufs sind an `status RUNNING` und das eigene `lockedUntil` gebunden. DB-Aktionen
 * entstehen zusammen mit dem Schrittzustand in einer Transaktion (genau einmal), die Mail wird ueber den
 * Claim `mailSentAt` hoechstens einmal gesendet. Der Status wandert nur vorwaerts (Guard in src/lib/db.ts).
 */
import { z } from "zod";
import { dbInternal, prisma } from "@/lib/db";
import { describeError } from "@/lib/safe-error";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { loadNotificationSettings } from "@/domain/notifications/settings";
import { onPaymentRuleFailed } from "@/domain/notifications/hooks";
import type { MailProvider } from "@/lib/mail/provider";
import { paymentRuleActionSchema, type PaymentRuleAction } from "@/schemas/payment-rule";
import { PaymentRuleError } from "./errors";
import { sendPaymentConfirmation } from "./mail";
import { performDbAction, actorOf, type ActionOutcome, type ActionRun, type RunContext } from "./actions";
import { nextAttemptAfterFailure, nextOpenStep, type StepState } from "./steps";

export const RUN_LOCK_MS = 5 * 60_000;
const DEFAULT_LIMIT = 50;
const ERROR_MAX = 500;

/** Ergebnis der Zahlungsbestaetigung: Schrittergebnis, Verschiebung (Versandgrenze) oder Fehler mit erneutem Versuch. */
export type ConfirmationResult = ActionOutcome | { status: "DEFER"; until: Date; note: string } | { status: "FAILED"; error: string };

/** Versand der Zahlungsbestaetigung; wird nur aufgerufen, nachdem der Claim `mailSentAt` gelungen ist. */
export type ConfirmationSender = (input: { run: ActionRun; action: Extract<PaymentRuleAction, { type: "SEND_PAYMENT_CONFIRMATION" }>; now: Date; provider?: MailProvider }) => Promise<ConfirmationResult>;

/** Standardversand ueber den Mailweg (Vorlage, Limits, Protokoll unter der Zahlung). Ohne Versand wird der Claim freigegeben. */
export const sendConfirmationViaMail: ConfirmationSender = async ({ run, action, now, provider }) => {
  const out = await sendPaymentConfirmation(
    { id: run.id, orgId: run.orgId, invoiceId: run.invoiceId, paymentId: run.paymentId, customerId: run.customerId, contextJson: JSON.stringify(run.context), ruleId: run.ruleId },
    { templateId: action.templateId },
    { now, ...(provider ? { provider } : {}) },
  );
  if (out.kind === "SENT") return { status: "DONE", note: `E-Mail ${out.logId}` };
  // Kein Versand erfolgt: Claim freigeben, damit der Lauf nicht auf das Mail-Limit zaehlt und ein Folgeversuch moeglich bleibt.
  await dbInternal.paymentRuleRun.updateMany({ where: { id: run.id, orgId: run.orgId, mailSentAt: now }, data: { mailSentAt: null } });
  if (out.kind === "ALREADY") return { status: "DONE", note: `bereits gesendet (E-Mail ${out.logId})` };
  if (out.kind === "SKIPPED") return { status: "SKIPPED", note: out.note };
  if (out.kind === "DEFER") return { status: "DEFER", until: out.until, note: out.note };
  return out.retryable ? { status: "FAILED", error: out.error } : { status: "SKIPPED", note: out.error };
};

export interface ProcessOptions {
  now?: Date;
  orgId?: string;
  limit?: number;
  provider?: MailProvider;
  runIds?: string[];
  /** Zahlungsbestaetigung; ohne Angabe der Versand ueber den Mailweg (`sendConfirmationViaMail`), in Tests ersetzbar. */
  sendConfirmation?: ConfirmationSender;
}

export interface ProcessResult {
  claimed: number;
  done: number;
  failed: number;
  skipped: number;
  deferred: number;
  retry: number;
}

const stepSchema = z.object({
  type: z.string(),
  status: z.enum(["PENDING", "DONE", "SKIPPED", "FAILED"]),
  at: z.string().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
});
const stepsSchema = z.array(stepSchema);
const contextSchema = z.object({
  amountCents: z.number().int(),
  paidAt: z.string(),
  openAfterCents: z.number().int(),
  currency: z.string(),
  invoiceNumber: z.string().nullable(),
});
const actionsSchema = z.array(paymentRuleActionSchema);

class LostRunError extends Error {
  constructor() {
    super("Lauf wurde von einem anderen Ausfuehrer uebernommen.");
    this.name = "LostRunError";
  }
}

const RUN_SELECT = {
  id: true, orgId: true, ruleId: true, paymentId: true, invoiceId: true, customerId: true, trigger: true, source: true,
  actionsJson: true, stepsJson: true, contextJson: true, status: true, attempts: true, lockedUntil: true,
} as const;

function truncate(s: string): string {
  return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX) : s;
}

function errorText(e: unknown): string {
  const d = describeError(e);
  return truncate([d.name, d.code, d.message].filter((x): x is string => typeof x === "string" && x !== "").join(": "));
}

type Outcome = "done" | "failed" | "skipped" | "retry" | "deferred" | "lost";

/** Grund, warum der Lauf nicht (weiter) ausgefuehrt werden darf; null = ausfuehren. */
async function precheck(run: { orgId: string; ruleId: string; paymentId: string; invoiceId: string; trigger: string }): Promise<string | null> {
  const rule = await dbInternal.paymentRule.findFirst({ where: { id: run.ruleId, orgId: run.orgId }, select: { active: true, archivedAt: true } });
  if (!rule || !rule.active || rule.archivedAt !== null) return "Regel deaktiviert";
  // Gegenbuchung der Zahlung oder ihrer Skontozahlung.
  const skonto = await dbInternal.payment.findMany({
    where: { skontoForPaymentId: run.paymentId, invoice: { orgId: run.orgId } },
    select: { id: true },
  });
  const reversed = await dbInternal.payment.count({
    where: { kind: "REVERSAL", reversesPaymentId: { in: [run.paymentId, ...skonto.map((s) => s.id)] }, invoice: { orgId: run.orgId } },
  });
  if (reversed > 0) return "Zahlung gegengebucht";
  const inv = await dbInternal.invoice.findFirst({ where: { id: run.invoiceId, orgId: run.orgId }, select: { status: true } });
  if (!inv) return "Rechnung nicht gefunden";
  if (inv.status === "CANCELLED") return "Rechnung storniert";
  if (run.trigger === "PAID_FULL" && inv.status !== "PAID") return "nicht mehr vollstaendig bezahlt";
  return null;
}

async function finish(runId: string, lock: Date, status: "DONE" | "SKIPPED", steps: StepState[], now: Date, skipReason: string | null): Promise<boolean> {
  const res = await prisma.paymentRuleRun.updateMany({
    where: { id: runId, status: "RUNNING", lockedUntil: lock },
    data: { status, stepsJson: JSON.stringify(steps), finishedAt: now, lockedUntil: null, lastError: null, skipReason },
  });
  return res.count === 1;
}

async function runClaimed(
  claimed: z.infer<typeof claimedSchema>,
  lock: Date,
  opts: { now: Date; provider?: MailProvider; sendConfirmation?: ConfirmationSender },
): Promise<Outcome> {
  const { now } = opts;
  const rule = await dbInternal.paymentRule.findFirst({ where: { id: claimed.ruleId, orgId: claimed.orgId }, select: { name: true } });
  const actions = actionsSchema.parse(JSON.parse(claimed.actionsJson));
  const context: RunContext = contextSchema.parse(JSON.parse(claimed.contextJson));
  const base: ActionRun = {
    id: claimed.id, orgId: claimed.orgId, ruleId: claimed.ruleId, ruleName: rule?.name ?? "", paymentId: claimed.paymentId,
    invoiceId: claimed.invoiceId, customerId: claimed.customerId, trigger: claimed.trigger, source: claimed.source, context,
  };
  const mine = { id: claimed.id, status: "RUNNING", lockedUntil: lock } as const;

  for (let guard = 0; guard < 20; guard += 1) {
    const fresh = await dbInternal.paymentRuleRun.findFirst({ where: { id: claimed.id }, select: { stepsJson: true, status: true, lockedUntil: true, attempts: true } });
    if (!fresh || fresh.status !== "RUNNING" || fresh.lockedUntil?.getTime() !== lock.getTime()) return "lost";
    const steps = stepsSchema.parse(JSON.parse(fresh.stepsJson)) as StepState[];
    const index = nextOpenStep(steps);
    if (index === null) {
      if (!(await finish(claimed.id, lock, "DONE", steps, now, null))) return "lost";
      await logActivity(dbInternal, {
        orgId: claimed.orgId, entityType: "INVOICE", entityId: claimed.invoiceId, type: "PAYMENT_RULE_EXECUTED", actor: actorOf(claimed.ruleId), at: now,
        data: { ruleId: claimed.ruleId, ruleName: base.ruleName, runId: claimed.id, steps: steps.map((s) => ({ type: s.type, status: s.status })) },
      });
      return "done";
    }

    const reason = await precheck(claimed);
    if (reason !== null) {
      const next = steps.map((s) => (s.status === "PENDING" || s.status === "FAILED" ? { ...s, status: "SKIPPED" as const, note: reason, at: now.toISOString() } : s));
      if (!(await finish(claimed.id, lock, "SKIPPED", next, now, reason))) return "lost";
      return "skipped";
    }

    const action = actions[index];
    if (!action) throw new PaymentRuleError("Schritt ohne Aktion.");
    const readSteps = fresh.stepsJson;
    try {
      const outcome = await runStep({ base, action, index, steps, readSteps, lock, now, mine, opts });
      if (outcome.status === "DEFER") {
        // Versandgrenze: Lauf spaeter erneut, dieser Versuch zaehlt nicht; Schritt bleibt offen.
        steps[index] = { type: action.type, status: "PENDING", note: outcome.note };
        const res = await prisma.paymentRuleRun.updateMany({
          where: mine,
          data: { status: "PENDING", nextAttemptAt: outcome.until, attempts: { decrement: 1 }, lockedUntil: null, lastError: null, stepsJson: JSON.stringify(steps) },
        });
        return res.count === 1 ? "deferred" : "lost";
      }
      if (outcome.status === "FAILED") throw new Error(outcome.error);
      steps[index] = { type: action.type, status: outcome.status, at: now.toISOString(), ...(outcome.note ? { note: outcome.note } : {}) };
      if (action.type === "SEND_PAYMENT_CONFIRMATION") {
        // Mail-Schritt: Zustand ausserhalb der Aktions-Transaktion, ebenfalls an Status und Sperre gebunden.
        const res = await prisma.paymentRuleRun.updateMany({ where: { ...mine, stepsJson: readSteps }, data: { stepsJson: JSON.stringify(steps) } });
        if (res.count === 0) return "lost";
      }
    } catch (e) {
      if (e instanceof LostRunError) return "lost";
      const message = errorText(e);
      steps[index] = { type: action.type, status: "FAILED", at: now.toISOString(), error: message };
      const retryAt = nextAttemptAfterFailure(fresh.attempts, now);
      const common = { stepsJson: JSON.stringify(steps), lastError: message, lockedUntil: null };
      if (retryAt !== null) {
        const res = await prisma.paymentRuleRun.updateMany({ where: mine, data: { ...common, status: "PENDING", nextAttemptAt: retryAt } });
        return res.count === 1 ? "retry" : "lost";
      }
      const res = await prisma.paymentRuleRun.updateMany({ where: mine, data: { ...common, status: "FAILED", finishedAt: now } });
      if (res.count === 1) {
        await onPaymentRuleFailed(claimed.orgId, {
          runId: claimed.id, ruleName: base.ruleName, invoiceId: claimed.invoiceId, invoiceNumber: context.invoiceNumber, message, at: now,
        });
        return "failed";
      }
      return "lost";
    }
  }
  throw new PaymentRuleError("Zu viele Schritte in einem Lauf.");
}

const claimedSchema = z.object({
  id: z.string(), orgId: z.string(), ruleId: z.string(), paymentId: z.string(), invoiceId: z.string(), customerId: z.string(),
  trigger: z.string(), source: z.string(), actionsJson: z.string(), stepsJson: z.string(), contextJson: z.string(),
});

async function runStep(p: {
  base: ActionRun;
  action: PaymentRuleAction;
  index: number;
  steps: StepState[];
  readSteps: string;
  lock: Date;
  now: Date;
  mine: { readonly id: string; readonly status: "RUNNING"; readonly lockedUntil: Date };
  opts: { provider?: MailProvider; sendConfirmation?: ConfirmationSender };
}): Promise<ConfirmationResult> {
  const { base, action, index, now } = p;
  if (action.type === "SEND_PAYMENT_CONFIRMATION") {
    // Atomarer Claim: nur wer mailSentAt von NULL auf einen Wert setzt, versendet.
    const claim = await prisma.paymentRuleRun.updateMany({ where: { ...p.mine, mailSentAt: null }, data: { mailSentAt: now } });
    if (claim.count !== 1) return { status: "DONE", note: "bereits versendet oder Versand unklar, nicht wiederholt" };
    return (p.opts.sendConfirmation ?? sendConfirmationViaMail)({ run: base, action, now, ...(p.opts.provider ? { provider: p.opts.provider } : {}) });
  }
  const notifyEnabled = action.type === "NOTIFY" ? (await loadNotificationSettings(base.orgId)).enabledTypes.includes("PAYMENT_RULE") : true;
  return dbInternal.$transaction(async (tx) => {
    const outcome = await performDbAction({ tx, run: base, action, index, now, notifyEnabled });
    const steps = p.steps.map((s, i) => (i === index ? { type: action.type, status: outcome.status, at: now.toISOString(), ...(outcome.note ? { note: outcome.note } : {}) } : s));
    const res = await tx.paymentRuleRun.updateMany({
      where: { ...p.mine, stepsJson: p.readSteps },
      data: { stepsJson: JSON.stringify(steps) },
    });
    if (res.count === 0) throw new LostRunError();
    return outcome;
  });
}

export async function processPaymentRuleRuns(opts: ProcessOptions = {}): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const result: ProcessResult = { claimed: 0, done: 0, failed: 0, skipped: 0, deferred: 0, retry: 0 };
  const candidates = await dbInternal.paymentRuleRun.findMany({
    where: {
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      ...(opts.runIds ? { id: { in: opts.runIds } } : {}),
      OR: [{ status: "PENDING", nextAttemptAt: { lte: now } }, { status: "RUNNING", lockedUntil: { lt: now } }],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: opts.limit ?? DEFAULT_LIMIT,
    select: { ...RUN_SELECT, nextAttemptAt: true },
  });
  for (const c of candidates) {
    const lock = new Date(now.getTime() + RUN_LOCK_MS);
    const won = await prisma.paymentRuleRun.updateMany({
      where: c.status === "PENDING"
        ? { id: c.id, status: "PENDING", nextAttemptAt: c.nextAttemptAt, attempts: c.attempts }
        : { id: c.id, status: "RUNNING", lockedUntil: c.lockedUntil, attempts: c.attempts },
      data: { status: "RUNNING", lockedUntil: lock, attempts: { increment: 1 } },
    });
    if (won.count !== 1) continue;
    result.claimed += 1;
    try {
      const outcome = await runClaimed(claimedSchema.parse(c), lock, {
        now, ...(opts.provider ? { provider: opts.provider } : {}), ...(opts.sendConfirmation ? { sendConfirmation: opts.sendConfirmation } : {}),
      });
      if (outcome === "done") result.done += 1;
      else if (outcome === "failed") result.failed += 1;
      else if (outcome === "skipped") result.skipped += 1;
      else if (outcome === "retry") result.retry += 1;
      else if (outcome === "deferred") result.deferred += 1;
    } catch (e) {
      // Unerwartet (z. B. kaputte JSON-Daten): Lauf endgueltig scheitern lassen, nie in der Schwebe lassen.
      console.error("Regel-Lauf fehlgeschlagen", describeError(e));
      const message = errorText(e);
      const res = await prisma.paymentRuleRun.updateMany({
        where: { id: c.id, status: "RUNNING", lockedUntil: lock },
        data: { status: "FAILED", lastError: message, finishedAt: now, lockedUntil: null },
      });
      if (res.count === 1) result.failed += 1;
    }
  }
  return result;
}

export interface PaymentRuleRunView {
  id: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
}

/** Wiederholt einen endgueltig fehlgeschlagenen Lauf: nur der fehlgeschlagene Schritt wird erneut versucht. */
export async function retryPaymentRuleRun(orgId: string, runId: string, actor: string): Promise<PaymentRuleRunView> {
  const run = await dbInternal.paymentRuleRun.findFirst({ where: { id: runId, orgId }, select: { id: true, status: true, stepsJson: true } });
  if (!run) throw new NotFoundError("Regel-Lauf nicht gefunden.");
  if (run.status !== "FAILED") throw new PaymentRuleError("Nur fehlgeschlagene Laeufe koennen wiederholt werden.");
  const now = new Date();
  const steps = stepsSchema
    .parse(JSON.parse(run.stepsJson))
    .map((s) => (s.status === "FAILED" ? { type: s.type, status: "PENDING" as const } : s));
  const res = await prisma.paymentRuleRun.updateMany({
    where: { id: runId, orgId, status: "FAILED" },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lockedUntil: null, lastError: null, finishedAt: null, stepsJson: JSON.stringify(steps) },
  });
  if (res.count !== 1) throw new PaymentRuleError("Nur fehlgeschlagene Laeufe koennen wiederholt werden.");
  await logActivity(dbInternal, { orgId, entityType: "PAYMENT_RULE", entityId: runId, type: "PAYMENT_RULE_EXECUTED", actor, at: now, data: { retry: true } });
  return { id: runId, status: "PENDING", attempts: 0, nextAttemptAt: now };
}
