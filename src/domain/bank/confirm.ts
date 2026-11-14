/**
 * Bankumsaetze zuordnen: bestaetigen (auch aufgeteilt), eindeutige Vorschlaege sammelhaft bestaetigen,
 * ignorieren, wieder oeffnen und Zuordnungen per Gegenbuchung zuruecknehmen.
 * Gebucht wird ausschliesslich ueber recordPaymentWithinTx / reversePaymentWithinTx (GoBD); es gibt
 * kein automatisches Buchen und einen Ueberschuss wird nie als Zahlung gebucht.
 */
import { dbInternal } from "@/lib/db";
import { lockRow, lockRows } from "@/lib/db-lock";
import { withChangeLogRetry } from "@/lib/chain-retry";
import { logActivity } from "@/domain/activity/log";
import { NotFoundError } from "@/domain/errors";
import { describeError } from "@/lib/safe-error";
import { PaymentError, recordPaymentWithinTx, type PaymentCreatedBy } from "@/domain/invoice/payment";
import { reversePaymentWithinTx } from "@/domain/invoice/payment-reversal";
import { bankConfirmInputSchema, bankConfirmUnambiguousInputSchema, bankIgnoreInputSchema, bankUndoInputSchema } from "@/schemas/bank";
import { BankAllocationError, BankConflictError } from "./errors";
import { bankIbanHash, suggestionsForPage } from "./suggest";
import type { Prisma } from "@/generated/prisma/client";

const TX_OPTIONS = { timeout: 60_000, maxWait: 10_000 } as const;
const REFERENCE_MAX = 140;
const UNAMBIGUOUS_MAX = 200;

export interface BankActionOptions {
  actor: string;
  createdBy: PaymentCreatedBy;
  now?: Date;
}

export interface BankTransactionView {
  id: string;
  status: string;
  direction: string;
  amountCents: number;
  allocatedCents: number;
  currency: string;
  bookingDate: Date;
  ignoredReason: string | null;
}

export const BANK_TX_VIEW_SELECT = {
  id: true,
  status: true,
  direction: true,
  amountCents: true,
  allocatedCents: true,
  currency: true,
  bookingDate: true,
  ignoredReason: true,
} as const;

export async function loadView(db: Prisma.TransactionClient, orgId: string, txId: string): Promise<BankTransactionView> {
  const row = await db.bankTransaction.findFirst({ where: { id: txId, orgId }, select: BANK_TX_VIEW_SELECT });
  if (!row) throw new NotFoundError("Bankumsatz nicht gefunden.");
  return row;
}

export interface ConfirmResult {
  transaction: BankTransactionView;
  payments: Array<{ invoiceId: string; paymentId: string; skontoPaymentId?: string }>;
}

export async function confirmBankMatch(orgId: string, txId: string, raw: unknown, opts: BankActionOptions): Promise<ConfirmResult> {
  const input = bankConfirmInputSchema.parse(raw);
  const now = opts.now ?? new Date();
  const invoiceIds = input.allocations.map((a) => a.invoiceId);
  if (new Set(invoiceIds).size !== invoiceIds.length) throw new BankAllocationError("Jede Rechnung darf nur einmal zugeordnet werden.");

  return withChangeLogRetry(() =>
    dbInternal.$transaction(async (tx) => {
      await lockRow(tx, "BankTransaction", txId, orgId);
      await lockRows(tx, orgId, invoiceIds.map((id) => ({ table: "Invoice" as const, id })));

      const bankTx = await tx.bankTransaction.findFirst({
        where: { id: txId, orgId },
        select: { id: true, status: true, direction: true, amountCents: true, allocatedCents: true, currency: true, bookingDate: true, remittance: true, counterpartyIban: true },
      });
      if (!bankTx) throw new NotFoundError("Bankumsatz nicht gefunden.");
      if (bankTx.allocatedCents !== input.expectedAllocatedCents) throw new BankConflictError();
      if (bankTx.direction !== "CRDT") throw new BankAllocationError("Nur Gutschriften koennen Rechnungen zugeordnet werden.");
      if (bankTx.status !== "OPEN" && bankTx.status !== "PARTIAL") {
        throw new BankAllocationError("Dieser Umsatz kann nicht zugeordnet werden (Status " + bankTx.status + ").");
      }

      const invoices = await tx.invoice.findMany({ where: { id: { in: invoiceIds }, orgId }, select: { id: true, currency: true, customerId: true } });
      if (invoices.length !== invoiceIds.length) throw new NotFoundError("Rechnung nicht gefunden.");
      const byId = new Map(invoices.map((i) => [i.id, i]));
      for (const i of invoices) {
        if (i.currency !== bankTx.currency) throw new BankAllocationError("Waehrung von Umsatz und Rechnung stimmen nicht ueberein.");
      }

      const sum = input.allocations.reduce((s, a) => s + a.amountCents, 0);
      const rest = bankTx.amountCents - bankTx.allocatedCents;
      if (sum > rest) throw new BankAllocationError(`Die Zuordnung (${sum} Cent) uebersteigt den freien Betrag des Umsatzes (${rest} Cent).`);

      let n = await tx.bankMatch.count({ where: { orgId, transactionId: txId, kind: "PAYMENT" } });
      const reference = bankTx.remittance.trim().slice(0, REFERENCE_MAX) || undefined;
      const payments: ConfirmResult["payments"] = [];

      for (const a of input.allocations) {
        n += 1;
        const res = await recordPaymentWithinTx(
          tx,
          a.invoiceId,
          {
            amountCents: a.amountCents,
            method: "TRANSFER",
            paidAt: bankTx.bookingDate,
            ...(reference ? { reference } : {}),
            applySkonto: a.applySkonto === true,
            isSkonto: false,
            note: "Bankabgleich",
          },
          { orgId, actor: opts.actor, createdBy: opts.createdBy, now, provider: "BANK", providerPaymentId: `${txId}:${n}` },
        );
        await tx.bankMatch.create({
          data: { orgId, transactionId: txId, invoiceId: a.invoiceId, paymentId: res.recorded.id, amountCents: a.amountCents, kind: "PAYMENT", confirmedBy: opts.actor, confirmedAt: now },
          select: { id: true },
        });
        if (res.skontoPayment) {
          await tx.bankMatch.create({
            data: { orgId, transactionId: txId, invoiceId: a.invoiceId, paymentId: res.skontoPayment.id, amountCents: res.skontoPayment.amountCents, kind: "SKONTO", confirmedBy: opts.actor, confirmedAt: now },
            select: { id: true },
          });
        }
        payments.push({ invoiceId: a.invoiceId, paymentId: res.recorded.id, ...(res.skontoPayment ? { skontoPaymentId: res.skontoPayment.id } : {}) });
      }

      const allocated = bankTx.allocatedCents + sum;
      const upd = await tx.bankTransaction.updateMany({
        where: { id: txId, orgId, allocatedCents: input.expectedAllocatedCents },
        data: { allocatedCents: allocated, status: allocated >= bankTx.amountCents ? "MATCHED" : "PARTIAL" },
      });
      if (upd.count === 0) throw new BankConflictError();

      const hash = bankIbanHash(bankTx.counterpartyIban);
      const firstInvoice = byId.get(input.allocations[0]!.invoiceId);
      if (hash && firstInvoice) {
        await tx.bankCounterpartyHint.upsert({
          where: { orgId_ibanHash: { orgId, ibanHash: hash } },
          create: { orgId, ibanHash: hash, customerId: firstInvoice.customerId, lastUsedAt: now },
          update: { customerId: firstInvoice.customerId, lastUsedAt: now, useCount: { increment: 1 } },
          select: { id: true },
        });
      }

      await logActivity(tx, {
        orgId,
        entityType: "BANK_TRANSACTION",
        entityId: txId,
        type: "BANK_MATCH_CONFIRMED",
        actor: opts.actor,
        at: now,
        data: { invoiceIds, amountsCents: input.allocations.map((a) => a.amountCents), allocatedCents: allocated },
      });
      return { transaction: await loadView(tx, orgId, txId), payments };
    }, TX_OPTIONS),
  );
}

function skipReason(e: unknown): string {
  if (e instanceof BankConflictError || e instanceof BankAllocationError || e instanceof PaymentError || e instanceof NotFoundError) return e.message;
  console.error("Bankabgleich: Buchung fehlgeschlagen", describeError(e));
  return "Buchung fehlgeschlagen.";
}

export async function confirmUnambiguous(
  orgId: string,
  raw: unknown,
  opts: BankActionOptions,
): Promise<{ confirmed: number; skipped: Array<{ transactionId: string; reason: string }>; truncated: boolean; remaining: number }> {
  const input = bankConfirmUnambiguousInputSchema.parse(raw ?? {});
  const explicit = input.transactionIds ? [...new Set(input.transactionIds)] : null;
  const where = { orgId, status: "OPEN", direction: "CRDT", ...(explicit ? { id: { in: explicit } } : {}) };
  const fetched = await dbInternal.bankTransaction.findMany({
    where,
    select: { id: true, allocatedCents: true },
    orderBy: [{ bookingDate: "asc" }, { id: "asc" }],
    take: UNAMBIGUOUS_MAX + 1,
  });
  const truncated = fetched.length > UNAMBIGUOUS_MAX;
  const rows = fetched.slice(0, UNAMBIGUOUS_MAX);
  const remaining = truncated ? Math.max(0, (await dbInternal.bankTransaction.count({ where })) - rows.length) : 0;
  const skipped: Array<{ transactionId: string; reason: string }> = [];
  if (explicit) {
    const found = new Set(rows.map((r) => r.id));
    for (const id of explicit) if (!found.has(id)) skipped.push({ transactionId: id, reason: "Umsatz ist nicht offen oder nicht zuordenbar." });
  }
  const suggestions = await suggestionsForPage(orgId, rows.map((r) => r.id));
  let confirmed = 0;
  for (const row of rows) {
    const sure = (suggestions.get(row.id) ?? []).filter((s) => s.confidence === "SICHER");
    const pick = sure.length === 1 ? sure[0]! : null;
    if (!pick) {
      if (explicit) skipped.push({ transactionId: row.id, reason: "Kein eindeutiger Vorschlag." });
      continue;
    }
    if (pick.allocations.some((a) => a.applySkonto)) {
      skipped.push({ transactionId: row.id, reason: "Skonto-Abzug nur einzeln mit Sicht bestaetigen." });
      continue;
    }
    try {
      await confirmBankMatch(
        orgId,
        row.id,
        {
          allocations: pick.allocations.map((a) => ({ invoiceId: a.invoiceId, amountCents: a.amountCents, applySkonto: a.applySkonto })),
          expectedAllocatedCents: row.allocatedCents,
        },
        opts,
      );
      confirmed += 1;
    } catch (e) {
      skipped.push({ transactionId: row.id, reason: skipReason(e) });
    }
  }
  return { confirmed, skipped, truncated, remaining };
}

export async function ignoreBankTransaction(orgId: string, txId: string, raw: unknown, opts: BankActionOptions): Promise<BankTransactionView> {
  const input = bankIgnoreInputSchema.parse(raw);
  const now = opts.now ?? new Date();
  return dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "BankTransaction", txId, orgId);
    const bankTx = await loadView(tx, orgId, txId);
    if (bankTx.status !== "OPEN" && bankTx.status !== "PARTIAL" && bankTx.status !== "RETURN") {
      throw new BankAllocationError("Nur offene, teilweise zugeordnete oder Rueckbuchungs-Umsaetze koennen ignoriert bzw. erledigt werden.");
    }
    const upd = await tx.bankTransaction.updateMany({
      where: { id: txId, orgId, status: bankTx.status, allocatedCents: bankTx.allocatedCents },
      data: { status: bankTx.status === "RETURN" ? "RETURN_DONE" : "IGNORED", ignoredReason: input.reason, ignoredBy: opts.actor, ignoredAt: now },
    });
    if (upd.count === 0) throw new BankConflictError();
    await logActivity(tx, {
      orgId,
      entityType: "BANK_TRANSACTION",
      entityId: txId,
      type: bankTx.status === "RETURN" ? "BANK_RETURN_DISMISSED" : "BANK_TRANSACTION_IGNORED",
      actor: opts.actor,
      at: now,
      data: { reason: input.reason, allocatedCents: bankTx.allocatedCents },
    });
    return loadView(tx, orgId, txId);
  }, TX_OPTIONS);
}

export async function reopenBankTransaction(orgId: string, txId: string, opts: BankActionOptions): Promise<BankTransactionView> {
  const now = opts.now ?? new Date();
  return dbInternal.$transaction(async (tx) => {
    await lockRow(tx, "BankTransaction", txId, orgId);
    const bankTx = await loadView(tx, orgId, txId);
    const dismissedReturn = bankTx.status === "RETURN_DONE" && bankTx.ignoredReason !== null;
    if (bankTx.status !== "IGNORED" && !dismissedReturn) {
      throw new BankAllocationError("Nur ignorierte oder als erledigt markierte Rueckbuchungen koennen wieder geoeffnet werden.");
    }
    if (bankTx.allocatedCents !== 0) throw new BankAllocationError("Der Umsatz ist teilweise zugeordnet; zuerst die Zuordnung zuruecknehmen.");
    const upd = await tx.bankTransaction.updateMany({
      where: { id: txId, orgId, status: bankTx.status, allocatedCents: 0 },
      data: { status: dismissedReturn ? "RETURN" : "OPEN", ignoredReason: null, ignoredBy: null, ignoredAt: null },
    });
    if (upd.count === 0) throw new BankConflictError();
    await logActivity(tx, {
      orgId,
      entityType: "BANK_TRANSACTION",
      entityId: txId,
      type: "BANK_TRANSACTION_REOPENED",
      actor: opts.actor,
      at: now,
      data: {},
    });
    return loadView(tx, orgId, txId);
  }, TX_OPTIONS);
}

export async function undoBankMatch(orgId: string, txId: string, raw: unknown, opts: BankActionOptions): Promise<BankTransactionView> {
  const input = bankUndoInputSchema.parse(raw);
  const now = opts.now ?? new Date();
  const done = await withChangeLogRetry(() =>
    dbInternal.$transaction(async (tx) => {
      await lockRow(tx, "BankTransaction", txId, orgId);
      const bankTx = await tx.bankTransaction.findFirst({
        where: { id: txId, orgId },
        select: { id: true, status: true, direction: true, allocatedCents: true },
      });
      if (!bankTx) throw new NotFoundError("Bankumsatz nicht gefunden.");
      // BankMatch hat keinen Fremdschluessel auf die Organisation: Org und Umsatz werden explizit geprueft.
      const match = await tx.bankMatch.findFirst({
        where: { id: input.matchId, orgId, transactionId: txId, kind: "PAYMENT" },
        select: { id: true, invoiceId: true, paymentId: true, amountCents: true },
      });
      if (!match || !match.paymentId) throw new NotFoundError("Zuordnung nicht gefunden.");
      if (bankTx.direction !== "CRDT" || !["OPEN", "PARTIAL", "MATCHED", "IGNORED"].includes(bankTx.status)) {
        throw new BankAllocationError("Die Zuordnung dieses Umsatzes kann nicht zurueckgenommen werden.");
      }
      // Rest der Zahlung (nach manuellen Teil-Gegenbuchungen): ist er 0, wurde die Zuordnung schon zurueckgenommen.
      const payment = await tx.payment.findUnique({ where: { id: match.paymentId }, select: { amountCents: true, paidAt: true } });
      const reversedAgg = await tx.payment.aggregate({ where: { reversesPaymentId: match.paymentId, kind: "REVERSAL" }, _sum: { amountCents: true } });
      if (!payment || payment.amountCents + (reversedAgg._sum.amountCents ?? 0) <= 0) throw new BankConflictError("Diese Zuordnung wurde bereits zurueckgenommen.");

      // reversePaymentWithinTx schreibt Umsatz (allocatedCents/Status) und UNDO-Eintrag fort. Eine Fehlzuordnung wird im
      // Zeitraum der urspruenglichen Zahlung neutralisiert (Datum der Zahlung), nicht im Monat der Korrektur.
      const reversed = await reversePaymentWithinTx(tx, match.paymentId, { reason: input.reason }, { actor: opts.actor, orgId, now, createdBy: opts.createdBy, reversedAt: payment.paidAt });
      await logActivity(tx, {
        orgId,
        entityType: "BANK_TRANSACTION",
        entityId: txId,
        type: "BANK_MATCH_UNDONE",
        actor: opts.actor,
        at: now,
        data: { matchId: match.id, invoiceId: match.invoiceId, amountCents: -reversed.reversal.amountCents, reason: input.reason },
      });
      return { view: await loadView(tx, orgId, txId), reversed, paymentId: match.paymentId };
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
      data: { paymentId: done.paymentId, amountCents: done.reversed.totalDelta, reason: input.reason, status: done.reversed.invoiceStatus },
    });
  } catch (e) {
    console.error("undoBankMatch: Aktivitaetsprotokoll fehlgeschlagen", e);
  }
  return done.view;
}
