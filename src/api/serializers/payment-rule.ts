import "../openapi-zod-init"; // MUSS vor jedem z.object()-Aufruf hier stehen
import { z } from "zod";
import { iso } from "./common";
import { PAYMENT_RULE_RUN_STATUSES, PAYMENT_RULE_TRIGGERS, paymentRuleActionSchema } from "@/schemas/payment-rule";
import type { PaymentRuleView } from "@/domain/payment-rule/rules";
import type { PaymentRuleRunDetail } from "@/domain/payment-rule/runs";
import type { PaymentRulePreview } from "@/domain/payment-rule/preview";

export function serializePaymentRule(r: PaymentRuleView) {
  return {
    objectName: "PaymentRule" as const,
    id: r.id,
    name: r.name,
    active: r.active,
    trigger: r.trigger,
    sources: r.sources,
    invoiceTagId: r.invoiceTagId,
    delayMinutes: r.delayMinutes,
    actions: r.actions,
    sortOrder: r.sortOrder,
    archivedAt: iso(r.archivedAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    tagMissing: r.tagMissing,
  };
}

export function serializePaymentRuleRun(r: PaymentRuleRunDetail) {
  return {
    objectName: "PaymentRuleRun" as const,
    id: r.id,
    ruleId: r.ruleId,
    ruleName: r.ruleName,
    paymentId: r.paymentId,
    invoiceId: r.invoiceId,
    trigger: r.trigger,
    source: r.source,
    actions: r.actions,
    steps: r.steps,
    context: r.context,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: iso(r.nextAttemptAt),
    lastError: r.lastError,
    skipReason: r.skipReason,
    mailSentAt: iso(r.mailSentAt),
    createdAt: iso(r.createdAt),
    finishedAt: iso(r.finishedAt),
  };
}

export const paymentRuleSchema = z.object({
  objectName: z.literal("PaymentRule"),
  id: z.string(),
  name: z.string(),
  active: z.boolean(),
  trigger: z.enum(PAYMENT_RULE_TRIGGERS),
  sources: z.array(z.string()).nullable(),
  invoiceTagId: z.string().nullable(),
  delayMinutes: z.number().int(),
  actions: z.array(paymentRuleActionSchema),
  sortOrder: z.number().int(),
  archivedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  tagMissing: z.boolean(),
});

export const paymentRuleRunSchema = z.object({
  objectName: z.literal("PaymentRuleRun"),
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  paymentId: z.string(),
  invoiceId: z.string(),
  trigger: z.string(),
  source: z.string(),
  actions: z.unknown(),
  steps: z.unknown(),
  context: z.unknown(),
  status: z.enum(PAYMENT_RULE_RUN_STATUSES),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastError: z.string().nullable(),
  skipReason: z.string().nullable(),
  mailSentAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const paymentRulePreviewSchema = z.object({
  matches: z.boolean(),
  reasons: z.array(z.string()),
  trigger: z.string().nullable(),
  source: z.string().nullable(),
  steps: z.array(
    z.object({
      type: z.string(),
      outcome: z.string(),
      mail: z.object({ to: z.string().nullable(), subject: z.string(), body: z.string() }).optional(),
    }),
  ),
});

export const serializePaymentRulePreview = (p: PaymentRulePreview) => p;
