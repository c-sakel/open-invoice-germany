/**
 * Aktionen eines Regel-Laufs. Jede DB-Aktion laeuft in der Transaktion des Ausfuehrers, die auch den
 * Schrittzustand fortschreibt (Wirkung und Zustand entstehen zusammen oder gar nicht). Die Mail ist
 * keine DB-Aktion: sie wird ueber den atomaren Claim `mailSentAt` hoechstens einmal versendet.
 */
import type { Payment, Prisma } from "@/generated/prisma/client";
import type { dbInternal } from "@/lib/db";
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
  customerId: string;
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
async function recurringIdsOf(tx: Prisma.TransactionClient | typeof dbInternal, orgId: string, invoiceId: string): Promise<string[]> {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { recurringInvoiceId: true } });
  const rels = await tx.documentRelation.findMany({
    where: { orgId, fromType: "INVOICE", fromId: invoiceId, toType: "RECURRING", relationType: "GENERATED_BY" },
    select: { toId: true },
  });
  const ids = new Set<string>(rels.map((r) => r.toId));
  if (inv?.recurringInvoiceId) ids.add(inv.recurringInvoiceId);
  return [...ids].sort();
}

const OPEN_INVOICE_STATUSES = ["FINALIZED", "SENT", "PARTIALLY_PAID"];

export interface RecurringCandidate {
  id: string;
  status: string;
  /** Eine weitere Rechnung des Abos ist noch offen (festgeschrieben, nicht bezahlt/storniert). */
  otherOpenInvoice: boolean;
}

/** Abos der Rechnung mit Status und der Angabe, ob das Abo eine weitere offene Rechnung hat. Rein lesend. */
export async function recurringCandidates(
  db: Prisma.TransactionClient | typeof dbInternal, orgId: string, invoiceId: string,
): Promise<RecurringCandidate[]> {
  const ids = await recurringIdsOf(db, orgId, invoiceId);
  const out: RecurringCandidate[] = [];
  for (const id of ids) {
    const rec = await db.recurringInvoice.findFirst({ where: { id, orgId }, select: { status: true } });
    if (!rec) continue;
    const rels = await db.documentRelation.findMany({
      where: { orgId, fromType: "INVOICE", toType: "RECURRING", relationType: "GENERATED_BY", toId: id },
      select: { fromId: true },
    });
    const related = rels.map((r) => r.fromId).filter((x) => x !== invoiceId);
    const open = await db.invoice.count({
      where: {
        orgId, id: { not: invoiceId }, type: { not: "CREDIT_NOTE" }, status: { in: OPEN_INVOICE_STATUSES },
        OR: [{ recurringInvoiceId: id }, ...(related.length > 0 ? [{ id: { in: related } }] : [])],
      },
    });
    out.push({ id, status: rec.status, otherOpenInvoice: open > 0 });
  }
  return out;
}

export const OTHER_OPEN_INVOICE_NOTE = "Weitere offene Rechnung des Abos";

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
      await logActivity(tx, {
        orgId: run.orgId, entityType: "INVOICE", entityId: run.invoiceId, type: "PAYMENT_RULE_EXECUTED", actor: actorOf(run.ruleId), at: now,
        data: { runId: run.id, step: action.type },
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
      await logActivity(tx, {
        orgId: run.orgId, entityType: "INVOICE", entityId: run.invoiceId, type: "PAYMENT_RULE_EXECUTED", actor: actorOf(run.ruleId), at: now,
        data: { runId: run.id, step: action.type },
      });
      const queued = await tx.webhookDelivery.count({ where: { orgId: run.orgId, event: "payment_rule.triggered", objectId: run.id } });
      return queued === 0 ? { status: "DONE", note: "kein Endpunkt abonniert" } : { status: "DONE" };
    }
    case "RESUME_RECURRING": {
      const candidates = await recurringCandidates(tx, run.orgId, run.invoiceId);
      if (candidates.length === 0) return { status: "SKIPPED", note: "keine Abos" };
      const notes: string[] = [];
      let resumedAny = false;
      let endedAny = false;
      let blockedAny = false;
      for (const { id, status, otherOpenInvoice } of candidates) {
        if (otherOpenInvoice && status === "PAUSED") {
          blockedAny = true;
          notes.push(OTHER_OPEN_INVOICE_NOTE);
          continue;
        }
        const r = await resumePausedRecurringWithinTx(tx, run.orgId, id, {
          missedPeriods: action.missedPeriods, now, actor: actorOf(run.ruleId), invoiceId: run.invoiceId,
        });
        notes.push(r.note);
        if (r.resumed) resumedAny = true;
        if (r.ended) endedAny = true;
      }
      // Nichts fortgesetzt und mindestens ein Abo endet im uebersprungenen Zeitraum: Schritt uebersprungen statt erledigt.
      const skipped = !resumedAny && (endedAny || blockedAny);
      return { status: skipped ? "SKIPPED" : "DONE", note: notes.join("; ").slice(0, 300) };
    }
    case "SEND_PAYMENT_CONFIRMATION":
      return { status: "SKIPPED", note: "nicht als Datenbankaktion ausfuehrbar" };
  }
}
