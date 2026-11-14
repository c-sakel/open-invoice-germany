/**
 * Ruecklastschriften/Rueckbuchungen (Umsatzstatus RETURN): Vorschlaege fuer die betroffene Zahlung und
 * die Gegenbuchung nach ausdruecklicher Bestaetigung. Ein Rueckbuchungs-Umsatz wird nie als Zahlung gebucht.
 */
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { reversePaymentWithinTx } from "@/domain/invoice/payment-reversal";
import { bankReturnInputSchema } from "@/schemas/bank";
import { BankAllocationError, BankConflictError } from "./errors";
import { loadView, type BankActionOptions, type BankTransactionView } from "./confirm";
import { returnHintsForPage } from "./suggest";
import type { Prisma } from "@/generated/prisma/client";

const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;

export interface ReturnSuggestion {
  paymentId: string;
  invoiceId: string;
  number: string;
  /** Noch nicht gegengebuchter Rest der Zahlung. */
  amountCents: number;
  reason: "SAME_E2E" | "NUMBER";
}

async function unreversedCents(db: Prisma.TransactionClient, paymentId: string, amountCents: number): Promise<number> {
  const agg = await db.payment.aggregate({ where: { reversesPaymentId: paymentId, kind: "REVERSAL" }, _sum: { amountCents: true } });
  return amountCents + (agg._sum.amountCents ?? 0);
}

export async function returnSuggestions(orgId: string, txId: string): Promise<ReturnSuggestion[]> {
  const bankTx = await dbInternal.bankTransaction.findFirst({
    where: { id: txId, orgId },
    select: { id: true, status: true, currency: true, endToEndId: true },
  });
  if (!bankTx) throw new NotFoundError("Bankumsatz nicht gefunden.");
  if (bankTx.status !== "RETURN") return [];

  const out = new Map<string, ReturnSuggestion>();
  const add = async (
    p: { id: string; amountCents: number; invoice: { id: string; number: string | null; currency: string; orgId: string } },
    reason: ReturnSuggestion["reason"],
  ): Promise<void> => {
    if (out.has(p.id) || p.invoice.orgId !== orgId || p.invoice.currency !== bankTx.currency || !p.invoice.number) return;
    const rest = await unreversedCents(dbInternal, p.id, p.amountCents);
    if (rest > 0) out.set(p.id, { paymentId: p.id, invoiceId: p.invoice.id, number: p.invoice.number, amountCents: rest, reason });
  };
  const PAYMENT_SELECT = { id: true, amountCents: true, invoice: { select: { id: true, number: true, currency: true, orgId: true } } } as const;

  if (bankTx.endToEndId) {
    const matches = await dbInternal.bankMatch.findMany({
      where: { orgId, kind: "PAYMENT", paymentId: { not: null }, transaction: { orgId, endToEndId: bankTx.endToEndId } },
      select: { payment: { select: PAYMENT_SELECT } },
      take: 20,
    });
    for (const m of matches) if (m.payment) await add(m.payment, "SAME_E2E");
  }

  const hints = (await returnHintsForPage(orgId, [txId])).get(txId) ?? [];
  if (hints.length > 0) {
    const payments = await dbInternal.payment.findMany({
      where: { invoiceId: { in: hints.map((h) => h.invoiceId) }, kind: "PAYMENT", isSkonto: false, skontoForPaymentId: null, method: { not: "CREDIT_NOTE" } },
      select: PAYMENT_SELECT,
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    for (const p of payments) await add(p, "NUMBER");
  }
  return [...out.values()];
}

export interface BankReturnResult {
  transaction: BankTransactionView;
  /** Rueckgabegebuehr der Bank (Umsatz groesser als die gegengebuchte Zahlung); wird nie gebucht. */
  feeCents: number;
  /** Der Umsatz war kleiner als der Rest der Zahlung: nur ein Teil wurde gegengebucht. */
  partial: boolean;
}

export async function confirmBankReturn(orgId: string, txId: string, raw: unknown, opts: BankActionOptions): Promise<BankReturnResult> {
  const input = bankReturnInputSchema.parse(raw);
  const now = opts.now ?? new Date();
  const done = await withChangeLogRetry(() =>
    dbInternal.$transaction(async (tx) => {
      await lockRow(tx, "BankTransaction", txId, orgId);
      const bankTx = await tx.bankTransaction.findFirst({
        where: { id: txId, orgId },
        select: { id: true, status: true, direction: true, amountCents: true, currency: true, returnReason: true },
      });
      if (!bankTx) throw new NotFoundError("Bankumsatz nicht gefunden.");
      if (bankTx.status !== "RETURN") throw new BankAllocationError("Nur Rueckbuchungen koennen als Ruecklastschrift gebucht werden.");

      if (bankTx.direction !== "DBIT") {
        throw new BankAllocationError("Eine Rueckbuchung zu einer eigenen Ausgangsbuchung kann nicht gegen Kundenzahlungen gebucht werden; bitte als erledigt markieren.");
      }

      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId, kind: "PAYMENT", invoice: { orgId } },
        select: { id: true, amountCents: true, invoiceId: true, invoice: { select: { currency: true } } },
      });
      if (!payment) throw new NotFoundError("Zahlung nicht gefunden.");
      if (payment.invoice.currency !== bankTx.currency) throw new BankAllocationError("Waehrung von Umsatz und Zahlung stimmen nicht ueberein.");

      const rest = await unreversedCents(tx, payment.id, payment.amountCents);
      if (rest <= 0) throw new BankAllocationError("Die Zahlung ist bereits vollstaendig gegengebucht.");
      const amountCents = Math.min(bankTx.amountCents, rest);
      const code = bankTx.returnReason ? ` ${bankTx.returnReason}` : "";
      const reason = `Ruecklastschrift${code}${input.reason ? `: ${input.reason}` : ""}`.slice(0, 500);

      const reversed = await reversePaymentWithinTx(tx, payment.id, { amountCents, reason }, { actor: opts.actor, orgId, now, createdBy: opts.createdBy, syncBank: false });
      const origin = await tx.bankMatch.findFirst({ where: { orgId, paymentId: payment.id }, select: { id: true } });
      await tx.bankMatch.create({
        data: {
          orgId,
          transactionId: txId,
          invoiceId: payment.invoiceId,
          paymentId: reversed.reversal.id,
          amountCents,
          kind: "REVERSAL",
          refMatchId: origin?.id ?? null,
          reason,
          confirmedBy: opts.actor,
          confirmedAt: now,
        },
        select: { id: true },
      });
      const upd = await tx.bankTransaction.updateMany({ where: { id: txId, orgId, status: "RETURN" }, data: { status: "RETURN_DONE" } });
      if (upd.count === 0) throw new BankConflictError();
      await logActivity(tx, {
        orgId,
        entityType: "BANK_TRANSACTION",
        entityId: txId,
        type: "BANK_RETURN_BOOKED",
        actor: opts.actor,
        at: now,
        data: { paymentId: payment.id, invoiceId: payment.invoiceId, amountCents, returnAmountCents: bankTx.amountCents, reason },
      });
      return { view: await loadView(tx, orgId, txId), reversed, paymentId: payment.id, reason, feeCents: Math.max(0, bankTx.amountCents - amountCents), partial: bankTx.amountCents < rest };
    }, TX_OPTIONS),
  );
  try {
    await logActivity(dbInternal, {
      orgId,
      entityType: "INVOICE",
      entityId: done.reversed.invoiceId,
      type: "PAYMENT_REVERSED",
      actor: opts.actor,
      at: now,
      data: { paymentId: done.paymentId, amountCents: done.reversed.totalDelta, reason: done.reason, status: done.reversed.invoiceStatus },
    });
  } catch (e) {
    console.error("confirmBankReturn: Aktivitaetsprotokoll fehlgeschlagen", e);
  }
  return { transaction: done.view, feeCents: done.feeCents, partial: done.partial };
}
