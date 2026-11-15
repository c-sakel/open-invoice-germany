/**
 * Aktionen eines Regel-Laufs. Jede DB-Aktion laeuft in der Transaktion des Ausfuehrers, die auch den
 * Schrittzustand fortschreibt (Wirkung und Zustand entstehen zusammen oder gar nicht). Die Mail ist
 * keine DB-Aktion: sie wird ueber den atomaren Claim `mailSentAt` hoechstens einmal versendet.
 */
import type { Payment, Prisma } from "@/generated/prisma/client";
import { logActivity } from "@/domain/activity/log";
import { emitEvent } from "@/domain/webhook/emit";
import { serializeInvoice } from "@/api/serializers/invoice";
import { serializePayment } from "@/api/serializers/payment";
import { formatCents } from "@/lib/money";
import { resumePausedRecurringWithinTx } from "@/domain/recurring/resume";
import type { PaymentRuleAction } from "@/schemas/payment-rule";

export interface RunContext {
  amountCents: number;
  paidAt: string;
  openAfterCents: number;
  currency: string;
  invoiceNumber: string | null;
}

export interface ActionRun {
  id: string;
  orgId: string;
  ruleId: string;
  ruleName: string;
  paymentId: string;
  invoiceId: string;
  trigger: string;
  source: string;
  context: RunContext;
}

export interface ActionInput {
  tx: Prisma.TransactionClient;
  run: ActionRun;
  action: PaymentRuleAction;
  index: number;
  now: Date;
  notifyEnabled: boolean;
}

export interface ActionOutcome {
  status: "DONE" | "SKIPPED";
  note?: string;
}

export const PAYMENT_SELECT = {
  id: true, invoiceId: true, amountCents: true, paidAt: true, method: true, reference: true, isSkonto: true, skontoForPaymentId: true,
  note: true, createdAt: true, kind: true, reversesPaymentId: true, reason: true, provider: true, providerPaymentId: true, createdBy: true,
} as const;

export const actorOf = (ruleId: string): string => `payment-rule:${ruleId}`;

/** Abos einer Rechnung: Herkunftsabo und Sammelrechnungs-Relationen, sortiert und ohne Duplikate. */
async function recurringIdsOf(tx: Prisma.TransactionClient, orgId: string, invoiceId: string): Promise<string[]> {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { recurringInvoiceId: true } });
  const rels = await tx.documentRelation.findMany({
    where: { orgId, fromType: "INVOICE", fromId: invoiceId, toType: "RECURRING", relationType: "GENERATED_BY" },
    select: { toId: true },
  });
  const ids = new Set<string>(rels.map((r) => r.toId));
  if (inv?.recurringInvoiceId) ids.add(inv.recurringInvoiceId);
  return [...ids].sort();
}

export async function performDbAction(input: ActionInput): Promise<ActionOutcome> {
  const { tx, run, action, index, now } = input;
  switch (action.type) {
    case "ADD_TAG": {
      const tag = await tx.tag.findFirst({ where: { id: action.tagId, orgId: run.orgId }, select: { id: true, name: true } });
      if (!tag) return { status: "SKIPPED", note: "Tag geloescht" };
      const existing = await tx.documentTag.findFirst({
        where: { orgId: run.orgId, tagId: tag.id, docType: "INVOICE", docId: run.invoiceId },
        select: { id: true },
      });
      if (existing) return { status: "DONE", note: "bereits gesetzt" };
      await tx.documentTag.create({ data: { orgId: run.orgId, tagId: tag.id, docType: "INVOICE", docId: run.invoiceId }, select: { id: true } });
      await logActivity(tx, {
        orgId: run.orgId, entityType: "INVOICE", entityId: run.invoiceId, type: "TAG_ADDED", actor: actorOf(run.ruleId), at: now,
        data: { tagId: tag.id, name: tag.name },
      });
      return { status: "DONE" };
    }
    case "NOTIFY": {
      if (!input.notifyEnabled) return { status: "SKIPPED", note: "Benachrichtigungstyp abgeschaltet" };
      const dedupeKey = `payment-rule:${run.id}:${index}`;
      const existing = await tx.notification.findFirst({ where: { orgId: run.orgId, dedupeKey }, select: { id: true } });
      if (existing) return { status: "DONE", note: "bereits benachrichtigt" };
      const c = run.context;
      const body = [
        `Betrag ${formatCents(c.amountCents, c.currency)}, offen ${formatCents(c.openAfterCents, c.currency)}.`,
        action.note ?? "",
      ].filter((x) => x !== "").join(" ");
      await tx.notification.create({
        data: {
          orgId: run.orgId, type: "PAYMENT_RULE", title: `Zahlung eingegangen: ${c.invoiceNumber ?? run.invoiceId} (${run.ruleName})`,
          body, link: `/rechnungen/${run.invoiceId}`, entityType: "INVOICE", entityId: run.invoiceId, createdAt: now, dedupeKey,
        },
        select: { id: true },
      });
      return { status: "DONE" };
    }
    case "EMIT_WEBHOOK": {
      const payment = await tx.payment.findFirst({ where: { id: run.paymentId, invoice: { orgId: run.orgId } }, select: PAYMENT_SELECT });
      const invoice = await tx.invoice.findFirst({ where: { id: run.invoiceId, orgId: run.orgId }, include: { lines: true } });
      if (!payment || !invoice) return { status: "SKIPPED", note: "Zahlung oder Rechnung nicht gefunden" };
      await emitEvent(tx, {
        orgId: run.orgId,
        type: "payment_rule.triggered",
        objectName: "PaymentRuleRun",
        objectId: run.id,
        now,
        data: {
          objectName: "PaymentRuleRun",
          id: run.id,
          rule: { id: run.ruleId, name: run.ruleName },
          trigger: run.trigger,
          source: run.source,
          payment: serializePayment(payment as Payment),
          invoice: serializeInvoice(invoice, new Set()),
        },
      });
      const queued = await tx.webhookDelivery.count({ where: { orgId: run.orgId, event: "payment_rule.triggered", objectId: run.id } });
      return queued === 0 ? { status: "DONE", note: "kein Endpunkt abonniert" } : { status: "DONE" };
    }
    case "RESUME_RECURRING": {
      const ids = await recurringIdsOf(tx, run.orgId, run.invoiceId);
      if (ids.length === 0) return { status: "SKIPPED", note: "keine Abos" };
      const notes: string[] = [];
      for (const id of ids) {
        const r = await resumePausedRecurringWithinTx(tx, run.orgId, id, {
          missedPeriods: action.missedPeriods, now, actor: actorOf(run.ruleId), invoiceId: run.invoiceId,
        });
        notes.push(r.note);
      }
      return { status: "DONE", note: notes.join("; ").slice(0, 300) };
    }
    case "SEND_PAYMENT_CONFIRMATION":
      return { status: "SKIPPED", note: "nicht als Datenbankaktion ausfuehrbar" };
  }
}
