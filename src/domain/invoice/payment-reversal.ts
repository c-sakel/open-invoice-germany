/**
 * Zahlungskorrektur per Gegenbuchung (Phase 16a, GoBD): Zahlungen sind append-only. Eine
 * Korrektur legt eine NEGATIVE Zahlungszeile (kind REVERSAL, reversesPaymentId) an und
 * verringert Invoice.paidAmountCents atomar (decrementPaidAmount); die urspruengliche Zeile
 * bleibt unveraendert sichtbar. Gegenbuchungen werden nicht selbst gegengebucht, die Summe der
 * Gegenbuchungen einer Zahlung ueberschreitet deren Betrag nie. Haengt an der Zahlung eine
 * Skonto-Zahlung, wird sie bei der Gegenbuchung des letzten Restes mit zurueckgebucht.
 * Die Methode der Gegenbuchung entspricht der der Zahlung, damit Erstattungssummen
 * (refundablePaidCents) die Zeilen automatisch neutralisieren.
 */
import { lockRow } from "@/lib/db-lock";
import type { Prisma, Payment } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { appendChangeLog } from "@/domain/audit";
import { logActivity } from "@/domain/activity/log";
import { emitEvent } from "@/domain/webhook/emit";
import { serializePayment } from "@/api/serializers/payment";
import { NotFoundError } from "@/domain/errors";
import { payableBaseCents } from "@/domain/invoice/amounts";
import { decrementPaidAmount } from "./paid-amount";
import { PaymentError, type PaymentCreatedBy } from "./payment";
import { deriveStatusAfterReversal } from "./payment-reversal-status";
import { reversePaymentInputSchema, type ReversePaymentInput } from "@/schemas/payment-correction";

export interface ReversePaymentResult {
  reversal: Payment;
  /** Mitgebuchte Gegenbuchung der zugehoerigen Skonto-Zahlung, falls vorhanden. */
  skontoReversal?: Payment;
  invoiceStatus: string;
  paidAmountCents: number;
}

interface OriginalRow {
  id: string;
  amountCents: number;
  method: string;
  isSkonto: boolean;
}

async function alreadyReversedCents(tx: Prisma.TransactionClient, paymentId: string): Promise<number> {
  const agg = await tx.payment.aggregate({ where: { reversesPaymentId: paymentId, kind: "REVERSAL" }, _sum: { amountCents: true } });
  return -(agg._sum.amountCents ?? 0);
}

async function createReversalRow(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  original: OriginalRow,
  amountCents: number,
  reason: string,
  now: Date,
  createdBy: PaymentCreatedBy,
): Promise<Payment> {
  return tx.payment.create({
    data: {
      invoiceId,
      amountCents: -amountCents,
      paidAt: now,
      method: original.method,
      isSkonto: original.isSkonto,
      kind: "REVERSAL",
      reversesPaymentId: original.id,
      reason,
      createdBy,
    },
  });
}

export interface ReversePaymentWithinTxResult extends ReversePaymentResult {
  orgId: string;
  invoiceId: string;
  /** Summe aller gebuchten Gegenbuchungen (Zahlung + Skonto) in Cent. */
  totalDelta: number;
}

/**
 * Rumpf von `reversePayment` in einer vom Aufrufer gehaltenen Transaktion (Bankabgleich: Zuordnung
 * zuruecknehmen). Das Aktivitaetsprotokoll schreibt der Aufrufer nach dem Commit (siehe `reversePayment`).
 */
export async function reversePaymentWithinTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  input: ReversePaymentInput,
  opts: { actor: string; orgId: string; now: Date; createdBy: PaymentCreatedBy; syncBank?: boolean },
): Promise<ReversePaymentWithinTxResult> {
  const now = opts.now;
  const createdBy = opts.createdBy;
  const syncBank = opts.syncBank !== false;
  // Stammt die Zahlung aus dem Bankabgleich, wird der Bankumsatz VOR der Rechnung gesperrt (gleiche
  // Reihenfolge wie im Bankpfad: Umsatz, dann Rechnung), damit keine Sperrkreuzung entsteht.
  const bankMatch = syncBank
    ? await tx.bankMatch.findFirst({ where: { orgId: opts.orgId, paymentId, kind: "PAYMENT" }, select: { id: true, transactionId: true, invoiceId: true } })
    : null;
  if (bankMatch) await lockRow(tx, "BankTransaction", bankMatch.transactionId, opts.orgId);
  // Zeilensperre (17b): zuerst nur die Rechnung der Zahlung ermitteln, sperren, dann alles weitere lesen.
  const ref = await tx.payment.findUnique({ where: { id: paymentId }, select: { invoiceId: true, invoice: { select: { orgId: true } } } });
  if (!ref || ref.invoice.orgId !== opts.orgId) throw new NotFoundError("Zahlung nicht gefunden.");
  await lockRow(tx, "Invoice", ref.invoiceId, ref.invoice.orgId);
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true, invoiceId: true, amountCents: true, method: true, isSkonto: true, kind: true, skontoForPaymentId: true,
      invoice: {
        select: { id: true, orgId: true, status: true, grossTotalCents: true, payableCents: true },
      },
    },
  });
  if (!payment || payment.invoice.orgId !== opts.orgId) throw new NotFoundError("Zahlung nicht gefunden.");
  const inv = payment.invoice;

  if (payment.kind !== "PAYMENT") throw new PaymentError("Eine Gegenbuchung kann nicht erneut gegengebucht werden.");
  if (payment.method === "CREDIT_NOTE") {
    throw new PaymentError("Die Verrechnung mit einer Gutschrift wird nicht ueber eine Gegenbuchung zurueckgenommen.");
  }
  if (payment.skontoForPaymentId) {
    throw new PaymentError("Eine Skontobuchung wird ueber die zugehoerige Zahlung gegengebucht.");
  }

  // Serialisierung paralleler Gegenbuchungen: no-op-Schreibzugriff sperrt die Rechnungszeile
  // (Postgres: Zeilensperre, SQLite: Schreibsperre) BEVOR die bisherigen Gegenbuchungen gelesen
  // werden — sonst koennten zwei Transaktionen denselben Rest sehen und zusammen ueber den
  // Zahlungsbetrag hinaus gegenbuchen. Die Summe wird zusaetzlich nach dem Insert geprueft.
  await tx.invoice.updateMany({ where: { id: inv.id }, data: { paidAmountCents: { increment: 0 } } });

  const reversed = await alreadyReversedCents(tx, payment.id);
  const restCents = payment.amountCents - reversed;
  if (restCents <= 0) throw new PaymentError("Die Zahlung ist bereits vollstaendig gegengebucht.");
  const amountCents = input.amountCents ?? restCents;
  if (amountCents > restCents) {
    throw new PaymentError(`Gegenbuchung (${amountCents} Cent) uebersteigt den noch nicht gegengebuchten Betrag (${restCents} Cent).`);
  }

  const reversal = await createReversalRow(tx, inv.id, payment, amountCents, input.reason, now, createdBy);
  if ((await alreadyReversedCents(tx, payment.id)) > payment.amountCents) {
    throw new PaymentError("Die Zahlung wurde parallel bereits gegengebucht.");
  }
  let totalDelta = amountCents;

  // Skonto-Zahlung zur Zahlung: wird NUR mit dem letzten Rest der Hauptzahlung (volle
  // Gegenbuchung) zurueckgebucht. Eine Teil-Gegenbuchung laesst die Skontobuchung stehen,
  // weil unklar ist, welcher Skontoanteil zum erstatteten Teilbetrag gehoert.
  let skontoReversal: Payment | undefined;
  if (amountCents === restCents) {
    const skonto = await tx.payment.findFirst({
      where: { skontoForPaymentId: payment.id, kind: "PAYMENT" },
      select: { id: true, amountCents: true, method: true, isSkonto: true },
    });
    if (skonto) {
      const skontoRest = skonto.amountCents - (await alreadyReversedCents(tx, skonto.id));
      if (skontoRest > 0) {
        skontoReversal = await createReversalRow(tx, inv.id, skonto, skontoRest, input.reason, now, createdBy);
        totalDelta += skontoRest;
      }
    }
  }

  const newPaid = await decrementPaidAmount(tx, inv.id, totalDelta);
  if (newPaid === null) throw new PaymentError("Die Gegenbuchung uebersteigt den gebuchten Zahlbetrag der Rechnung.");

  // Phase 16d: ein echter Postversand (TEST zaehlt nicht) gilt wie ein versendeter E-Mail-Beleg als ausgegeben.
  const hasOutput =
    (await tx.emailLog.count({ where: { docId: inv.id, status: "SENT" } })) > 0 ||
    (await tx.postalJob.count({ where: { docType: "INVOICE", docId: inv.id, mode: "LIVE", status: { in: ["QUEUED", "HOLD", "DONE"] } } })) > 0;
  const status = deriveStatusAfterReversal({
    status: inv.status,
    paidCents: newPaid,
    baseCents: payableBaseCents(inv),
    hasOutput,
  });
  if (status !== inv.status) {
    await tx.invoice.update({ where: { id: inv.id }, data: { status }, select: { id: true } });
  }

  await appendChangeLog(tx, {
    orgId: inv.orgId,
    entity: "INVOICE",
    entityId: inv.id,
    action: "PAYMENT_REVERSAL",
    actor: opts.actor,
    at: now,
    diff: { paymentId: payment.id, amountCents: totalDelta, reason: input.reason, paidAmountCents: newPaid, status },
  });

  // Bankabgleich: der Umsatz haelt nur noch die netto aktiven Zahlungsbetraege (Hauptzahlung ohne Skonto).
  if (bankMatch) {
    const bankTx = await tx.bankTransaction.findFirst({
      where: { id: bankMatch.transactionId, orgId: opts.orgId },
      select: { amountCents: true, allocatedCents: true, status: true },
    });
    if (bankTx) {
      const allocated = Math.max(0, bankTx.allocatedCents - amountCents);
      const nextStatus = bankTx.status === "IGNORED" ? "IGNORED" : allocated === 0 ? "OPEN" : allocated >= bankTx.amountCents ? "MATCHED" : "PARTIAL";
      const upd = await tx.bankTransaction.updateMany({
        where: { id: bankMatch.transactionId, orgId: opts.orgId, allocatedCents: bankTx.allocatedCents },
        data: { allocatedCents: allocated, status: nextStatus },
      });
      if (upd.count === 0) throw new PaymentError("Der Bankumsatz wurde parallel geaendert; bitte erneut versuchen.");
      await tx.bankMatch.create({
        data: {
          orgId: opts.orgId,
          transactionId: bankMatch.transactionId,
          invoiceId: bankMatch.invoiceId,
          amountCents,
          kind: "UNDO",
          refMatchId: bankMatch.id,
          reason: input.reason,
          confirmedBy: opts.actor,
          confirmedAt: now,
        },
        select: { id: true },
      });
    }
  }

  for (const row of skontoReversal ? [reversal, skontoReversal] : [reversal]) {
    await emitEvent(tx, {
      orgId: inv.orgId,
      type: "payment.reversed",
      objectName: "Payment",
      objectId: row.id,
      data: serializePayment(row),
      now,
    });
  }

  return { reversal, ...(skontoReversal ? { skontoReversal } : {}), invoiceStatus: status, paidAmountCents: newPaid, orgId: inv.orgId, invoiceId: inv.id, totalDelta };
}

export async function reversePayment(
  paymentId: string,
  rawInput: ReversePaymentInput,
  opts: { actor: string; orgId: string; now?: Date; createdBy?: PaymentCreatedBy },
): Promise<ReversePaymentResult> {
  const input = reversePaymentInputSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  const createdBy = opts.createdBy ?? "user";

  const result = await dbInternal.$transaction((tx) => reversePaymentWithinTx(tx, paymentId, input, { actor: opts.actor, orgId: opts.orgId, now, createdBy }));

  try {
    await logActivity(dbInternal, {
      orgId: result.orgId,
      entityType: "INVOICE",
      entityId: result.invoiceId,
      type: "PAYMENT_REVERSED",
      actor: opts.actor,
      at: now,
      data: { paymentId, amountCents: result.totalDelta, reason: input.reason, status: result.invoiceStatus },
    });
  } catch (e) {
    // Die Gegenbuchung ist bereits festgeschrieben; ein Protokollfehler darf sie nicht melden als gescheitert.
    console.error("reversePayment: Aktivitaetsprotokoll fehlgeschlagen", e);
  }

  return {
    reversal: result.reversal,
    ...(result.skontoReversal ? { skontoReversal: result.skontoReversal } : {}),
    invoiceStatus: result.invoiceStatus,
    paidAmountCents: result.paidAmountCents,
  };
}
