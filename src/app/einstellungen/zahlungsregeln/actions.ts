"use server";

/**
 * Server-Actions der Regeln nach Zahlungseingang: gleiche Schemas und Domainfunktionen wie REST und MCP,
 * Organisation aus der Sitzung. Fehler gehen nur als feste Texte nach aussen (Rohtexte bleiben im Server-Log).
 */
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { describeError } from "@/lib/safe-error";
import { dbInternal } from "@/lib/db";
import { NotFoundError } from "@/domain/errors";
import { PaymentRuleError } from "@/domain/payment-rule/errors";
import { archivePaymentRule, createPaymentRule, updatePaymentRule } from "@/domain/payment-rule/rules";
import { previewPaymentRule, type PaymentRulePreview } from "@/domain/payment-rule/preview";
import { retryPaymentRuleRun } from "@/domain/payment-rule/execute";
import { getPaymentRuleRun } from "@/domain/payment-rule/runs";
import { GENERIC_ACTION_ERROR } from "@/domain/payment-rule/public-error";
import { kickPaymentRules } from "@/domain/payment-rule/kick";
import { isMailFollowUp, ruleIssueText } from "@/components/payment-rules/rule-form-model";

export type RuleActionResult<T = undefined> = ({ ok: true } & (T extends undefined ? Record<never, never> : { data: T })) | { ok: false; error: string };

const idSchema = z.string().min(1).max(64);
const previewInputSchema = z.object({ ruleId: idSchema, invoiceNumber: z.string().trim().min(1, "Bitte eine Rechnungsnummer eingeben.").max(64) });
const retryInputSchema = z.object({ runId: idSchema, confirmFollowUp: z.boolean() });

function failure(e: unknown): { ok: false; error: string } {
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return { ok: false, error: i ? ruleIssueText(i) : "Ungültige Eingabe." };
  }
  if (e instanceof PaymentRuleError || e instanceof NotFoundError) return { ok: false, error: e.message };
  console.error("Zahlungsregeln:", describeError(e));
  return { ok: false, error: GENERIC_ACTION_ERROR };
}

async function ctx(): Promise<{ orgId: string; actor: string }> {
  const org = await getActiveOrg();
  return { orgId: org.id, actor: (await getCurrentUserId()) ?? "system" };
}

function refresh(): void {
  revalidatePath("/einstellungen/zahlungsregeln");
  revalidatePath("/rechnungen/[id]", "page");
}

export async function createPaymentRuleAction(input: unknown): Promise<RuleActionResult<{ id: string }>> {
  try {
    const c = await ctx();
    const rule = await createPaymentRule(c.orgId, input, c.actor);
    refresh();
    return { ok: true, data: { id: rule.id } };
  } catch (e) {
    return failure(e);
  }
}

export async function updatePaymentRuleAction(id: string, patch: unknown): Promise<RuleActionResult> {
  try {
    const c = await ctx();
    await updatePaymentRule(c.orgId, idSchema.parse(id), patch, c.actor);
    refresh();
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

export async function archivePaymentRuleAction(id: string): Promise<RuleActionResult> {
  try {
    const c = await ctx();
    await archivePaymentRule(c.orgId, idSchema.parse(id), c.actor);
    refresh();
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}

/** Trockenlauf gegen eine Rechnung (Nummer): rein lesend, kein Protokoll, keine Mail, kein Tag. */
export async function previewPaymentRuleAction(raw: unknown): Promise<RuleActionResult<PaymentRulePreview>> {
  try {
    const input = previewInputSchema.parse(raw);
    const c = await ctx();
    const invoice = await dbInternal.invoice.findFirst({ where: { orgId: c.orgId, number: input.invoiceNumber }, select: { id: true } });
    if (!invoice) return { ok: false, error: "Rechnung nicht gefunden." };
    return { ok: true, data: await previewPaymentRule(c.orgId, input.ruleId, invoice.id) };
  } catch (e) {
    return failure(e);
  }
}

/** Wiederholt einen fehlgeschlagenen Lauf; bei einem Mail-Schritt nur mit ausdruecklicher Bestaetigung des Folgeversands. */
export async function retryPaymentRuleRunAction(raw: unknown): Promise<RuleActionResult> {
  try {
    const input = retryInputSchema.parse(raw);
    const c = await ctx();
    const run = await getPaymentRuleRun(c.orgId, input.runId);
    if (isMailFollowUp(run.steps) && !input.confirmFollowUp) {
      return { ok: false, error: "Der Folgeversand der Mail muss bestätigt werden." };
    }
    await retryPaymentRuleRun(c.orgId, input.runId, c.actor);
    kickPaymentRules(c.orgId);
    refresh();
    return { ok: true };
  } catch (e) {
    return failure(e);
  }
}
