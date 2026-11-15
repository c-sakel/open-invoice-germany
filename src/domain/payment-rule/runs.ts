/** Lesezugriff auf die Laeufe der Regeln nach Zahlungseingang (Liste mit Filtern, Einzelansicht). */
import { z } from "zod";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { paymentRuleRunListFilterSchema } from "@/schemas/payment-rule";
import { publicErrorText, publicSteps } from "./public-error";
import type { Prisma } from "@/generated/prisma/client";

const RUN_SELECT = {
  id: true, ruleId: true, paymentId: true, invoiceId: true, customerId: true, trigger: true, source: true, actionsJson: true,
  stepsJson: true, contextJson: true, status: true, attempts: true, nextAttemptAt: true, lastError: true, skipReason: true,
  mailSentAt: true, createdAt: true, finishedAt: true, rule: { select: { name: true } },
} as const;

export interface PaymentRuleRunDetail {
  id: string;
  ruleId: string;
  ruleName: string;
  paymentId: string;
  invoiceId: string;
  customerId: string;
  trigger: string;
  source: string;
  actions: unknown;
  steps: unknown;
  context: unknown;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  skipReason: string | null;
  mailSentAt: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
}

type Row = Prisma.PaymentRuleRunGetPayload<{ select: typeof RUN_SELECT }>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toView(r: Row): PaymentRuleRunDetail {
  return {
    id: r.id, ruleId: r.ruleId, ruleName: r.rule.name, paymentId: r.paymentId, invoiceId: r.invoiceId, customerId: r.customerId,
    trigger: r.trigger, source: r.source, actions: parseJson(r.actionsJson), steps: publicSteps(parseJson(r.stepsJson)), context: parseJson(r.contextJson),
    status: r.status, attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, lastError: publicErrorText(r.lastError), skipReason: r.skipReason,
    mailSentAt: r.mailSentAt, createdAt: r.createdAt, finishedAt: r.finishedAt,
  };
}

export async function listPaymentRuleRuns(orgId: string, raw: unknown): Promise<{ rows: PaymentRuleRunDetail[]; total: number }> {
  const f = paymentRuleRunListFilterSchema.parse(raw);
  const where: Prisma.PaymentRuleRunWhereInput = {
    orgId,
    ...(f.status ? { status: f.status } : {}),
    ...(f.ruleId ? { ruleId: f.ruleId } : {}),
    ...(f.invoiceId ? { invoiceId: f.invoiceId } : {}),
    ...(f.paymentId ? { paymentId: f.paymentId } : {}),
  };
  const [rows, total] = await Promise.all([
    dbInternal.paymentRuleRun.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.limit, skip: f.offset, select: RUN_SELECT }),
    dbInternal.paymentRuleRun.count({ where }),
  ]);
  return { rows: rows.map(toView), total };
}

export async function getPaymentRuleRun(orgId: string, id: string): Promise<PaymentRuleRunDetail> {
  const row = await dbInternal.paymentRuleRun.findFirst({ where: { id: z.string().min(1).parse(id), orgId }, select: RUN_SELECT });
  if (!row) throw new NotFoundError("Regel-Lauf nicht gefunden.");
  return toView(row);
}
