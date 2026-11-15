/**
 * Abgleich eines Bezahlvorgangs mit dem Zustand beim Anbieter und Buchung. Der Zustand wird immer per
 * API geladen (nie aus einem Webhook-Body); gebucht wird ausschliesslich ueber `recordPaymentWithinTx`
 * (Zahlung) und `reversePaymentWithinTx` (Erstattung/Rueckbuchung, kumulativ). Orga-Zuordnung immer aus dem
 * eigenen Vorgang bzw. Link, nie aus Anbieterdaten.
 */
import { randomUUID } from "node:crypto";
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { Prisma } from "@/generated/prisma/client";
import { adapterFor } from "@/lib/payment/registry";
import { defaultPaymentTransport } from "@/lib/payment/transport";
import { ONLINE_PROVIDERS, type OnlineProvider, type PaymentTransport, type ProviderPaymentState } from "@/lib/payment/types";
import { describeError } from "@/lib/safe-error";
import { recordPaymentWithinTx, type PaymentCreatedBy } from "@/domain/invoice/payment";
import { reversePaymentWithinTx } from "@/domain/invoice/payment-reversal";
import { kickPaymentRules } from "@/domain/payment-rule/kick";
import { notifyOnlinePaymentWithinTx, onOnlinePaymentNotice } from "@/domain/notifications/hooks";
import { payableBaseCents } from "@/domain/invoice/amounts";
import { OnlinePaymentError } from "./errors";
import { cancelOpenAttemptsAfterCommit } from "./cancel-open";
import { eventIdFor, planReconcile, providerCentsFromEventId, providerSplitFromEventId, type AttemptStatus, type ReconcilePlan } from "./reconcile-plan";
import { loadProviderSecret } from "./settings";

export function onlineActor(provider: OnlineProvider): string {
  return `online-payment:${provider.toLowerCase()}`;
}

export interface ReconcileOpts {
  createdBy: PaymentCreatedBy;
  actor: string;
  now?: Date;
}

export interface ReconcileResult {
  result: string;
  paymentId: string | null;
  duplicate: boolean;
}

export type ReconcileOutcome =
  | (ReconcileResult & { kind: "RECONCILED" })
  | { kind: "NO_KEY" | "NOT_FOUND" | "NO_OBJECT" };

function money(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")} ${currency}`;
}

const FROM_OPEN: AttemptStatus[] = ["CREATING", "OPEN"];

function detailFor(plan: ReconcilePlan, state: ProviderPaymentState): string {
  const parts: string[] = [`Status ${state.status}`];
  if (plan.book !== null) parts.push(`gebucht ${plan.book} Cent`);
  if (plan.overpaidCents > 0) parts.push(`Ueberzahlung ${plan.overpaidCents} Cent`);
  if (plan.unassigned) parts.push(plan.unassigned === "CANCELLED" ? "Rechnung storniert, nicht gebucht" : "nichts offen, nicht gebucht");
  if (plan.reverse) parts.push(`gegengebucht ${plan.reverse.cents} Cent`);
  if (plan.coveredByManualCents > 0) {
    const kind = state.chargedBackCents > 0 ? (state.refundedCents > 0 ? "Erstattung/Rueckbuchung" : "Rueckbuchung") : "Erstattung";
    parts.push(`${kind} bereits gegengebucht (${plan.coveredByManualCents} Cent)`);
  }
  if (plan.review) parts.push(`pruefen: ${plan.review}`);
  if (plan.result === "TEST") parts.push("Testmodus, nicht gebucht");
  return parts.join("; ").slice(0, 500);
}

export async function reconcileAttempt(attemptId: string, state: ProviderPaymentState, opts: ReconcileOpts): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const attempt = await dbInternal.paymentProviderAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, orgId: true, provider: true, providerObjectId: true, amountCents: true, currency: true, payLink: { select: { orgId: true, invoiceId: true } } },
  });
  if (!attempt || attempt.providerObjectId !== state.objectId || attempt.payLink.orgId !== attempt.orgId) {
    throw new OnlinePaymentError("Bezahlvorgang nicht gefunden.", "NOT_FOUND");
  }
  const { orgId } = attempt;
  const provider = ONLINE_PROVIDERS.find((p) => p === attempt.provider);
  if (!provider) throw new OnlinePaymentError("Unbekannter Zahlungsanbieter.", "NOT_FOUND");
  const paymentRef = state.paymentRef ?? state.objectId;
  const invoiceId = attempt.payLink.invoiceId;
  const account = await dbInternal.paymentProviderAccount.findUnique({ where: { orgId_provider: { orgId, provider } }, select: { mode: true } });
  const accountTestMode = account?.mode === "TEST";
  const eventId = eventIdFor(state);

  try {
    const out = await withChangeLogRetry(() =>
      dbInternal.$transaction(async (tx) => {
        await lockRow(tx, "Invoice", invoiceId, orgId);
        // Zahlungs-Id des Anbieters (Stripe: PaymentIntent) am Vorgang festhalten, damit spaetere Ereignisse ihn finden.
        if (paymentRef !== state.objectId) {
          await tx.paymentProviderAttempt.updateMany({ where: { id: attempt.id, orgId, providerPaymentRef: null }, data: { providerPaymentRef: paymentRef } });
        }
        const dup = await tx.paymentProviderEvent.findUnique({ where: { provider_eventId: { provider, eventId } }, select: { id: true } });
        if (dup) {
          // Unveraenderter Zustand: Pruefzeitpunkt trotzdem fortschreiben, damit der Abgleich reihum laeuft.
          await tx.paymentProviderAttempt.updateMany({ where: { id: attempt.id, orgId }, data: { lastCheckedAt: now } });
          return { duplicate: true as const };
        }

        const inv = await tx.invoice.findFirst({
          where: { id: invoiceId, orgId },
          select: { id: true, status: true, number: true, currency: true, grossTotalCents: true, payableCents: true, paidAmountCents: true },
        });
        if (!inv) throw new OnlinePaymentError("Rechnung nicht gefunden.", "NOT_FOUND");
        const existing = await tx.payment.findUnique({
          where: { provider_providerPaymentId: { provider, providerPaymentId: paymentRef } },
          select: { id: true, invoiceId: true, amountCents: true, kind: true },
        });
        if (existing && existing.invoiceId !== invoiceId) throw new OnlinePaymentError("Zahlung gehoert zu einer anderen Rechnung.", "NOT_FOUND");
        let booked: { paymentId: string; amountCents: number; reversedCents: number } | null = null;
        if (existing) {
          const agg = await tx.payment.aggregate({ where: { reversesPaymentId: existing.id, kind: "REVERSAL" }, _sum: { amountCents: true } });
          booked = { paymentId: existing.id, amountCents: existing.amountCents, reversedCents: -(agg._sum.amountCents ?? 0) };
        }
        const prev = await tx.paymentProviderEvent.findFirst({
          where: { provider, objectId: state.objectId, result: { in: ["APPLIED", "TEST"] } },
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          select: { eventId: true },
        });
        const openCents = payableBaseCents(inv) - inv.paidAmountCents;
        const creditNotes = await tx.invoice.count({
          where: { orgId, correctsInvoiceId: invoiceId, type: "CREDIT_NOTE", status: { not: "DRAFT" } },
        });
        const plan = planReconcile({
          state,
          accountTestMode,
          attempt: { id: attempt.id, amountCents: attempt.amountCents, currency: attempt.currency },
          booked,
          invoice: { status: inv.status, openCents },
          previousProviderCents: prev ? providerCentsFromEventId(prev.eventId) : null,
          previousRefundedCents: prev ? (providerSplitFromEventId(prev.eventId)?.refunded ?? null) : null,
          hasCreditNote: creditNotes > 0,
        });

        let paymentId = booked?.paymentId ?? null;
        let changed = false;
        if (plan.book !== null) {
          const rec = await recordPaymentWithinTx(
            tx,
            invoiceId,
            { amountCents: plan.book, paidAt: state.paidAt ?? now, method: "ONLINE", reference: paymentRef, isSkonto: false, applySkonto: false },
            { orgId, actor: onlineActor(provider), createdBy: opts.createdBy, now, provider, providerPaymentId: paymentRef },
          );
          paymentId = rec.recorded.id;
          changed = true;
        }
        if (plan.reverse && paymentId) {
          await reversePaymentWithinTx(tx, paymentId, { amountCents: plan.reverse.cents, reason: plan.reverse.reason }, {
            actor: onlineActor(provider),
            orgId,
            now,
            createdBy: opts.createdBy,
            syncBank: false,
          });
          changed = true;
        }

        const num = inv.number ?? "";
        if (plan.overpaidCents > 0) {
          await notifyOnlinePaymentWithinTx(tx, orgId, {
            type: "ONLINE_OVERPAYMENT",
            title: `Online-Zahlung hoeher als offener Betrag${num ? ` (${num})` : ""}`,
            body: `Der Anbieter meldet ${money(state.amountCents, inv.currency)}, gebucht wurden ${money(plan.book ?? 0, inv.currency)}. Der Rest (${money(plan.overpaidCents, inv.currency)}) ist zu erstatten.`,
            invoiceId,
            dedupeKey: `online:${eventId}:over`,
            at: now,
          });
        }
        if (plan.unassigned) {
          await notifyOnlinePaymentWithinTx(tx, orgId, {
            type: "ONLINE_PAYMENT_ISSUE",
            title: `Online-Zahlung nicht gebucht${num ? ` (${num})` : ""}`,
            body: `${plan.unassigned === "CANCELLED" ? "Die Rechnung ist storniert" : "Die Rechnung hat keinen offenen Betrag"}; ${money(state.amountCents, inv.currency)} wurden beim Anbieter bezahlt und sind zu erstatten.`,
            invoiceId,
            dedupeKey: `online:${eventId}:unassigned`,
            at: now,
          });
        }
        if (plan.review) {
          const why =
            plan.review === "REFUND_WITH_CREDIT_NOTE"
              ? `Erstattung beim Zahlungsanbieter (${money(plan.refundNoticeCents, inv.currency)}) – bitte manuell zuordnen. Zur Rechnung${num ? ` ${num}` : ""} existiert eine Gutschrift; es wurde nichts gegengebucht.`
              : plan.review === "REVERSAL_DECREASED"
              ? "Die Erstattung/Rueckbuchung beim Anbieter wurde verringert oder aufgehoben; bitte von Hand pruefen und ggf. neu buchen."
              : plan.review === "MODE_MISMATCH"
                ? "Der Modus (Test/Live) der Zahlung passt nicht zum Zugang; es wurde nichts gebucht."
                : "Betrag, Waehrung oder Vorgang der Zahlung passen nicht zum Bezahlvorgang; es wurde nichts gebucht.";
          await notifyOnlinePaymentWithinTx(tx, orgId, {
            type: "ONLINE_PAYMENT_ISSUE",
            title: plan.review === "REFUND_WITH_CREDIT_NOTE" ? `Erstattung beim Zahlungsanbieter${num ? ` (${num})` : ""}` : `Online-Zahlung pruefen${num ? ` (${num})` : ""}`,
            body: why,
            invoiceId,
            dedupeKey: `online:${eventId}:review`,
            at: now,
          });
        }
        if (plan.result === "TEST") {
          await notifyOnlinePaymentWithinTx(tx, orgId, {
            type: "ONLINE_PAYMENT_ISSUE",
            title: `Testzahlung eingegangen${num ? ` (${num})` : ""}`,
            body: "Der Zugang steht auf Testmodus; die Zahlung wurde nicht gebucht.",
            invoiceId,
            dedupeKey: `online:${eventId}:test`,
            at: now,
          });
        }

        if (plan.attemptStatus !== null) {
          const from = plan.attemptStatus === "OPEN" ? ["CREATING"] : FROM_OPEN;
          await tx.paymentProviderAttempt.updateMany({
            where: { id: attempt.id, orgId, status: { in: from } },
            data: { status: plan.attemptStatus, lastCheckedAt: now },
          });
        }
        await tx.paymentProviderAttempt.updateMany({ where: { id: attempt.id, orgId }, data: { lastCheckedAt: now } });

        await tx.paymentProviderEvent.create({
          data: {
            orgId,
            provider,
            eventId,
            type: "payment.status",
            objectId: state.objectId,
            attemptId: attempt.id,
            receivedAt: now,
            result: plan.result,
            detail: detailFor(plan, state),
          },
          select: { id: true },
        });
        const after = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } });
        return { duplicate: false as const, paymentId, changed, plan, invoiceStatus: after.status };
      }),
    );
    if (out.duplicate) return { result: "IGNORED", paymentId: null, duplicate: true };
    if (out.changed) kickPaymentRules(orgId);
    if (out.invoiceStatus === "PAID" || out.invoiceStatus === "CANCELLED") cancelOpenAttemptsAfterCommit(orgId, invoiceId);
    return { result: out.plan.result, paymentId: out.paymentId, duplicate: false };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const dupEvent = await dbInternal.paymentProviderEvent.findUnique({ where: { provider_eventId: { provider, eventId } }, select: { id: true } });
      if (dupEvent) {
        await dbInternal.paymentProviderAttempt.updateMany({ where: { id: attempt.id, orgId }, data: { lastCheckedAt: now } });
        return { result: "IGNORED", paymentId: null, duplicate: true };
      }
    }
    // Fehlerzeile ausserhalb der Transaktion (eigene Id, blockiert keine Wiederholung); Schluessel/Details nie im Text.
    try {
      await dbInternal.paymentProviderEvent.create({
        data: {
          orgId,
          provider,
          eventId: `${eventId}#err-${randomUUID()}`,
          type: "payment.status",
          objectId: state.objectId,
          attemptId: attempt.id,
          receivedAt: now,
          result: "ERROR",
          detail: `Abgleich fehlgeschlagen (${describeError(e).name})`.slice(0, 500),
        },
        select: { id: true },
      });
    } catch (inner) {
      console.error("reconcileAttempt: Fehlerereignis nicht gespeichert", describeError(inner));
    }
    throw e;
  }
}

/** Laedt den Zustand beim Anbieter und gleicht ab. Kein Schluessel / kein Vorgang -> Hinweis statt Fehler. */
export async function refreshAttempt(
  orgId: string,
  attemptId: string,
  opts: ReconcileOpts & { transport?: PaymentTransport },
): Promise<ReconcileOutcome> {
  const attempt = await dbInternal.paymentProviderAttempt.findFirst({
    where: { id: attemptId, orgId },
    select: { id: true, provider: true, providerObjectId: true },
  });
  if (!attempt) return { kind: "NOT_FOUND" };
  if (!attempt.providerObjectId) return { kind: "NO_OBJECT" };
  const provider = ONLINE_PROVIDERS.find((p) => p === attempt.provider);
  if (!provider) return { kind: "NOT_FOUND" };
  const secret = await loadProviderSecret(orgId, provider);
  if (!secret) return { kind: "NO_KEY" };
  const now = opts.now ?? new Date();
  const state = await adapterFor(provider).fetchPayment(secret.key, attempt.providerObjectId, opts.transport ?? defaultPaymentTransport());
  if (!state) {
    await dbInternal.paymentProviderAttempt.updateMany({ where: { id: attempt.id, orgId }, data: { lastCheckedAt: now } });
    return { kind: "RECONCILED", result: "IGNORED", paymentId: null, duplicate: false };
  }
  const res = await reconcileAttempt(attempt.id, state, opts);
  return { kind: "RECONCILED", ...res };
}

/** Meldet ein dauerhaftes Anbieterproblem einmal je Tag (ausserhalb einer Transaktion). */
export async function reportProviderProblem(orgId: string, title: string, body: string, now: Date, key: string): Promise<void> {
  await onOnlinePaymentNotice(orgId, { type: "ONLINE_PAYMENT_ISSUE", title, body, dedupeKey: `online:${key}:${now.toISOString().slice(0, 10)}`, at: now });
}
