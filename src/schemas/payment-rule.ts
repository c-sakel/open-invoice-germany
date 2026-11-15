/** Zod-Schemas der Regeln nach Zahlungseingang. */
import { z } from "zod";

export const PAYMENT_RULE_TRIGGERS = ["PAID_FULL", "PAID_PARTIAL"] as const;
export const PAYMENT_SOURCES = ["MANUAL", "API", "MCP", "BANK"] as const;
export const PAYMENT_RULE_ACTION_TYPES = ["SEND_PAYMENT_CONFIRMATION", "ADD_TAG", "NOTIFY", "EMIT_WEBHOOK", "RESUME_RECURRING"] as const;
export const PAYMENT_RULE_RUN_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED", "SKIPPED"] as const;

// Pruefung per refine statt regex: ein regex mit u-Flag landet in der OpenAPI-Datei als ungueltiges "pattern".
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;
const noControlChars = (s: string): boolean => !FORBIDDEN_CHARS.test(s);
const CHARS_MESSAGE = "Keine Steuer- oder Formatzeichen erlaubt.";

export const paymentRuleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SEND_PAYMENT_CONFIRMATION"), templateId: z.string().min(1).nullable().default(null) }),
  z.object({ type: z.literal("ADD_TAG"), tagId: z.string().min(1) }),
  z.object({ type: z.literal("NOTIFY"), note: z.string().trim().max(300).refine(noControlChars, { message: CHARS_MESSAGE }).optional() }),
  z.object({ type: z.literal("EMIT_WEBHOOK") }),
  z.object({ type: z.literal("RESUME_RECURRING"), missedPeriods: z.enum(["SKIP", "BILL"]) }),
]);
export type PaymentRuleAction = z.infer<typeof paymentRuleActionSchema>;

const actionsSchema = z
  .array(paymentRuleActionSchema)
  .min(1)
  .max(5)
  .superRefine((actions, ctx) => {
    const seen = new Set<string>();
    for (const [i, a] of actions.entries()) {
      if (seen.has(a.type)) ctx.addIssue({ code: "custom", path: [i], message: "Jede Aktionsart hoechstens einmal je Regel." });
      seen.add(a.type);
    }
  });

export const paymentRuleInputSchema = z.object({
  name: z.string().trim().min(1).max(100).refine(noControlChars, { message: CHARS_MESSAGE }),
  active: z.boolean().default(true),
  trigger: z.enum(PAYMENT_RULE_TRIGGERS),
  sources: z.array(z.enum(PAYMENT_SOURCES)).min(1).nullable().default(null),
  invoiceTagId: z.string().min(1).nullable().default(null),
  delayMinutes: z.number().int().min(0).max(1440).default(5),
  actions: actionsSchema,
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type PaymentRuleInput = z.infer<typeof paymentRuleInputSchema>;

/** Teiländerung: nur uebergebene Felder, keine Defaults (sonst wuerden Felder unbemerkt zurueckgesetzt). */
export const paymentRuleUpdateSchema = z.object({
  name: paymentRuleInputSchema.shape.name.optional(),
  active: z.boolean().optional(),
  trigger: z.enum(PAYMENT_RULE_TRIGGERS).optional(),
  sources: z.array(z.enum(PAYMENT_SOURCES)).min(1).nullable().optional(),
  invoiceTagId: z.string().min(1).nullable().optional(),
  delayMinutes: z.number().int().min(0).max(1440).optional(),
  actions: actionsSchema.optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
export type PaymentRuleUpdate = z.infer<typeof paymentRuleUpdateSchema>;

export const paymentRuleRunListFilterSchema = z.object({
  status: z.enum(PAYMENT_RULE_RUN_STATUSES).optional(),
  ruleId: z.string().min(1).optional(),
  invoiceId: z.string().min(1).optional(),
  paymentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PaymentRuleRunListFilter = z.infer<typeof paymentRuleRunListFilterSchema>;
