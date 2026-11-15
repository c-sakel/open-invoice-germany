/**
 * Regel-Laeufe entstehen in der Transaktion der Zahlung (Outbox): schlaegt die Zahlung fehl,
 * gibt es auch keinen Lauf. Dieses Modul nimmt nur die Transaktion des Aufrufers und importiert
 * keine Zahlungs- oder Bankfunktionen (Architekturtest), damit keine Importschleife entsteht.
 */
import type { Prisma } from "@/generated/prisma/client";
import { paymentRuleActionSchema } from "@/schemas/payment-rule";
import { z } from "zod";
import { matchRules, paymentSource, triggerFor } from "./match";
import { initialSteps, sortMailLast } from "./steps";

/** Schleifenbremse: hoechstens so viele Laeufe je Regel und Rechnung, danach nur noch Protokoll (SKIPPED). */
export const RUNS_PER_RULE_AND_INVOICE_MAX = 20;
const CAP_REASON = "Obergrenze je Rechnung erreicht";

const actionsSchema = z.array(paymentRuleActionSchema);
const stepsSchema = z.array(z.object({ type: z.string(), status: z.string() }).passthrough());

/** Defekte Regeln werden je Prozess nur einmal gemeldet (nur die Id, keine Werte). */
const reportedBrokenRules = new Set<string>();
function reportBrokenRule(ruleId: string): void {
  if (reportedBrokenRules.has(ruleId)) return;
  reportedBrokenRules.add(ruleId);
  console.error("Regel nach Zahlungseingang ist defekt und wird uebersprungen", { ruleId });
}

/** JSON-Text ohne Ausnahme parsen; Fehler ergeben null. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface EnqueueInput {
  orgId: string;
  invoiceId: string;
  customerId: string;
  invoiceNumber: string | null;
  currency: string;
  payment: { id: string; amountCents: number; paidAt: Date; createdBy: string; provider: string | null };
  finalStatus: string;
  openAfterCents: number;
  now: Date;
}

export async function enqueuePaymentRuleRuns(tx: Prisma.TransactionClient, input: EnqueueInput): Promise<{ created: number }> {
  const trigger = triggerFor(input.finalStatus);
  if (trigger === null) return { created: 0 };

  const rules = await tx.paymentRule.findMany({
    where: { orgId: input.orgId, active: true, archivedAt: null, trigger },
    select: {
      id: true, active: true, archivedAt: true, trigger: true, sourcesJson: true, invoiceTagId: true,
      sortOrder: true, createdAt: true, delayMinutes: true, actionsJson: true,
    },
  });
  if (rules.length === 0) return { created: 0 };

  const needsTags = rules.some((r) => r.invoiceTagId !== null);
  const tags = needsTags
    ? await tx.documentTag.findMany({
        where: { orgId: input.orgId, docType: "INVOICE", docId: input.invoiceId },
        select: { tagId: true },
      })
    : [];
  const source = paymentSource(input.payment.createdBy, input.payment.provider);
  const matched = matchRules(rules, { trigger, source, invoiceTagIds: new Set(tags.map((t) => t.tagId)) });

  const contextJson = JSON.stringify({
    amountCents: input.payment.amountCents,
    paidAt: input.payment.paidAt.toISOString(),
    openAfterCents: input.openAfterCents,
    currency: input.currency,
    invoiceNumber: input.invoiceNumber,
  });

  let created = 0;
  for (const rule of matched) {
    const parsed = actionsSchema.safeParse(parseJson(rule.actionsJson));
    if (!parsed.success) {
      reportBrokenRule(rule.id); // kaputte Regel wird nie ausgefuehrt, die Zahlung bleibt unberuehrt
      continue;
    }
    const previous = await tx.paymentRuleRun.count({ where: { orgId: input.orgId, ruleId: rule.id, invoiceId: input.invoiceId } });
    const capped = previous >= RUNS_PER_RULE_AND_INVOICE_MAX;
    const actions = sortMailLast(parsed.data);
    const steps = initialSteps(actions).map((s) => (capped ? { ...s, status: "SKIPPED" as const, note: CAP_REASON } : s));
    await tx.paymentRuleRun.create({
      data: {
        orgId: input.orgId,
        ruleId: rule.id,
        paymentId: input.payment.id,
        invoiceId: input.invoiceId,
        customerId: input.customerId,
        trigger,
        source,
        actionsJson: JSON.stringify(actions),
        stepsJson: JSON.stringify(steps),
        contextJson,
        status: capped ? "SKIPPED" : "PENDING",
        nextAttemptAt: new Date(input.now.getTime() + rule.delayMinutes * 60_000),
        ...(capped ? { skipReason: CAP_REASON, finishedAt: input.now } : {}),
      },
      select: { id: true },
    });
    created += 1;
  }
  return { created };
}

/** Offene (noch nicht gestartete) Laeufe einer Zahlung anhalten, z. B. nach Gegenbuchung. */
export async function skipOpenRunsForPayment(tx: Prisma.TransactionClient, orgId: string, paymentId: string, reason: string): Promise<number> {
  const open = await tx.paymentRuleRun.findMany({
    where: { orgId, paymentId, status: "PENDING" },
    select: { id: true, stepsJson: true },
  });
  let n = 0;
  for (const run of open) {
    const parsedSteps = stepsSchema.safeParse(parseJson(run.stepsJson));
    // Defekte Schritte: Lauf trotzdem anhalten, Schritte unveraendert lassen.
    const steps = parsedSteps.success
      ? parsedSteps.data.map((s) => (s.status === "PENDING" || s.status === "FAILED" ? { ...s, status: "SKIPPED", note: reason } : s))
      : null;
    const res = await tx.paymentRuleRun.updateMany({
      where: { id: run.id, status: "PENDING" },
      data: { status: "SKIPPED", skipReason: reason, finishedAt: new Date(), ...(steps ? { stepsJson: JSON.stringify(steps) } : {}) },
    });
    n += res.count;
  }
  return n;
}
