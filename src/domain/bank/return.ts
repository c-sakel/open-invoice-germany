/**
 * Ruecklastschriften/Rueckbuchungen (Umsatzstatus RETURN): Vorschlaege fuer die betroffene Zahlung und
 * die Gegenbuchung nach ausdruecklicher Bestaetigung. Ein Rueckbuchungs-Umsatz wird nie als Zahlung gebucht.
 */
import { dbInternal } from "@/lib/db";
import { lockRow } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { onPaymentChangedKu } from "@/domain/notifications/hooks";
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

const PAYMENT_SELECT = { id: true, amountCents: true, invoice: { select: { id: true, number: true, currency: true, orgId: true } } } as const;
type SuggestPayment = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

/**
 * Vorschlaege fuer mehrere Rueckbuchungs-Umsaetze mit einer festen Zahl von Abfragen (Batch
 * ueber `in`), unabhaengig von der Zeilenzahl. Jede gefundene Umsatz-Id erscheint im Ergebnis
 * (bei anderem Status als RETURN mit leerer Liste); unbekannte oder fremde Ids fehlen.
 */
export async function returnSuggestionsForRows(orgId: string, txIds: string[]): Promise<Map<string, ReturnSuggestion[]>> {
  const result = new Map<string, ReturnSuggestion[]>();
  const ids = [...new Set(txIds)];
  if (ids.length === 0) return result;
  const txs = await dbInternal.bankTransaction.findMany({
    where: { id: { in: ids }, orgId },
    select: { id: true, status: true, currency: true, endToEndId: true },
  });
  const returns = txs.filter((t) => t.status === "RETURN");
  for (const t of txs) result.set(t.id, []);
  if (returns.length === 0) return result;

  // Zahlungen ueber gleiche Ende-zu-Ende-Referenz (hoechstens 20 je Referenz).
  const e2eIds = [...new Set(returns.map((t) => t.endToEndId).filter((e): e is string => Boolean(e)))];
  const matchesByE2e = new Map<string, SuggestPayment[]>();
  if (e2eIds.length > 0) {
    const matches = await dbInternal.bankMatch.findMany({
      where: { orgId, kind: "PAYMENT", paymentId: { not: null }, transaction: { orgId, endToEndId: { in: e2eIds } } },
      select: { payment: { select: PAYMENT_SELECT }, transaction: { select: { endToEndId: true } } },
    });
    for (const m of matches) {
      const e2e = m.transaction.endToEndId;
      if (!e2e || !m.payment) continue;
      const list = matchesByE2e.get(e2e) ?? [];
      if (list.length < 20) list.push(m.payment);
      matchesByE2e.set(e2e, list);
    }
  }

  // Rechnungsnummern-Hinweise (gebuendelt) und deren Zahlungen (hoechstens 50 je Umsatz).
  const hintsByTx = await returnHintsForPage(orgId, returns.map((t) => t.id));
  const invoiceIds = [...new Set([...hintsByTx.values()].flatMap((hs) => hs.map((h) => h.invoiceId)))];
  let hintPayments: Array<SuggestPayment & { invoiceId: string }> = [];
  if (invoiceIds.length > 0) {
    hintPayments = await dbInternal.payment.findMany({
      where: { invoiceId: { in: invoiceIds }, kind: "PAYMENT", isSkonto: false, skontoForPaymentId: null, method: { not: "CREDIT_NOTE" } },
      select: { ...PAYMENT_SELECT, invoiceId: true },
      orderBy: { createdAt: "asc" },
    });
  }

  // Bereits gegengebuchte Betraege aller beteiligten Zahlungen.
  const allPaymentIds = new Set<string>(hintPayments.map((p) => p.id));
  for (const list of matchesByE2e.values()) for (const p of list) allPaymentIds.add(p.id);
  const reversedByPayment = new Map<string, number>();
  if (allPaymentIds.size > 0) {
    const groups = await dbInternal.payment.groupBy({
      by: ["reversesPaymentId"],
      where: { reversesPaymentId: { in: [...allPaymentIds] }, kind: "REVERSAL" },
      _sum: { amountCents: true },
    });
    for (const g of groups) if (g.reversesPaymentId) reversedByPayment.set(g.reversesPaymentId, g._sum.amountCents ?? 0);
  }

  for (const t of returns) {
    const out = new Map<string, ReturnSuggestion>();
    const add = (p: SuggestPayment, reason: ReturnSuggestion["reason"]): void => {
      if (out.has(p.id) || p.invoice.orgId !== orgId || p.invoice.currency !== t.currency || !p.invoice.number) return;
      const rest = p.amountCents + (reversedByPayment.get(p.id) ?? 0);
      if (rest > 0) out.set(p.id, { paymentId: p.id, invoiceId: p.invoice.id, number: p.invoice.number, amountCents: rest, reason });
    };
    if (t.endToEndId) for (const p of matchesByE2e.get(t.endToEndId) ?? []) add(p, "SAME_E2E");
    const hintInvoices = new Set((hintsByTx.get(t.id) ?? []).map((h) => h.invoiceId));
    if (hintInvoices.size > 0) {
      for (const p of hintPayments.filter((x) => hintInvoices.has(x.invoiceId)).slice(0, 50)) add(p, "NUMBER");
    }
    result.set(t.id, [...out.values()]);
  }
  return result;
}

export async function returnSuggestions(orgId: string, txId: string): Promise<ReturnSuggestion[]> {
  const found = (await returnSuggestionsForRows(orgId, [txId])).get(txId);
  if (!found) throw new NotFoundError("Bankumsatz nicht gefunden.");
  return found;
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
        select: { id: true, status: true, direction: true, amountCents: true, currency: true, returnReason: true, bookingDate: true },
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

      const reversed = await reversePaymentWithinTx(tx, payment.id, { amountCents, reason }, { actor: opts.actor, orgId, now, createdBy: opts.createdBy, syncBank: false, reversedAt: bankTx.bookingDate });
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
  // Die Gegenbuchung zaehlt im Jahr der Bankbuchung (reversedAt = Buchungstag); Umsatzgrenzen neu auswerten.
  await onPaymentChangedKu(orgId, opts.now);
  return { transaction: done.view, feeCents: done.feeCents, partial: done.partial };
}
