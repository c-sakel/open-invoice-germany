/**
 * Abgrenzung Automatik/manueller Versand (klein gehalten, damit `email/send.ts` ohne Zyklus darauf zugreifen kann).
 */
import type { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { logActivity } from "@/domain/activity/log";
import { notifyRecurringNotSentWithinTx } from "@/domain/notifications/hooks";

/** Akteur der Versandautomatik im EmailLog (`sentByUserId`). */
export const AUTO_SEND_ACTOR = "recurring-runner";

export class AutoSendRunningError extends Error {
  constructor() {
    super("Automatischer Versand läuft für diese Rechnung. Bitte kurz warten und das Versandprotokoll prüfen.");
    this.name = "AutoSendRunningError";
  }
}

/** Status, solange ein manueller Versand die Zeile sperrt (nicht claimbar fuer die Automatik). */
export const MANUAL_PENDING = "MANUAL_PENDING";
const CLAIMABLE = ["PENDING", "RETRY", "NO_ADDRESS"] as const;

type ProblemStatus = "NO_ADDRESS" | "UNCLEAR" | "GAVE_UP" | "BOUNCED";
const isProblem = (s: string): s is ProblemStatus => s === "NO_ADDRESS" || s === "UNCLEAR" || s === "GAVE_UP" || s === "BOUNCED";

/**
 * Pflicht-Benachrichtigung + Aktivitaet fuer einen Problemzustand, in der Transaktion des Statuswechsels.
 * Einmal je Zustand und Zyklus (`notifiedStatus`); wiederholte NO_ADDRESS-Pruefungen melden nicht erneut.
 */
export async function reportAutoSendProblemWithinTx(
  tx: Prisma.TransactionClient,
  rowId: string,
  status: string,
  code: string | null,
  at: Date,
): Promise<void> {
  if (!isProblem(status)) return;
  const row = await tx.invoiceAutoSend.findUnique({ where: { id: rowId }, select: { orgId: true, invoiceId: true, attempts: true, cycle: true, notifiedStatus: true } });
  if (!row || row.notifiedStatus === status) return;
  const invoice = await tx.invoice.findFirst({ where: { id: row.invoiceId, orgId: row.orgId }, select: { number: true } });
  await logActivity(tx, {
    orgId: row.orgId,
    entityType: "INVOICE",
    entityId: row.invoiceId,
    type: "AUTO_SEND_PROBLEM",
    actor: AUTO_SEND_ACTOR,
    at,
    data: { status, code, attempts: row.attempts },
  });
  await notifyRecurringNotSentWithinTx(tx, row.orgId, { invoiceId: row.invoiceId, number: invoice?.number ?? null, status, cycle: row.cycle, at });
  await tx.invoiceAutoSend.update({ where: { id: rowId }, data: { notifiedStatus: status }, select: { id: true } });
}

export interface ManualSendLock {
  /**
   * Nach dem Versuch (nur wenn noch gesperrt): SENT -> DONE_MANUAL; NOT_SENT (sicher nichts versendet) -> vorheriger Zustand;
   * UNCLEAR (Ausgang unklar, Mail koennte raus sein) -> UNCLEAR mit Pflicht-Meldung, die Automatik sendet nicht erneut.
   */
  release(outcome: "SENT" | "NOT_SENT" | "UNCLEAR"): Promise<void>;
}

/**
 * Atomare Sperre fuer den manuellen Versand: bedingtes `updateMany` PENDING/RETRY/NO_ADDRESS -> MANUAL_PENDING.
 * Laeuft die Automatik (SENDING), wird abgelehnt. Gegenrichtung: der Claim der Automatik verlangt PENDING/RETRY/NO_ADDRESS
 * und scheitert an MANUAL_PENDING. Ohne Zeile oder in Endzustaenden ist nichts zu sperren (Rueckgabe `null`).
 * Aufruf unmittelbar vor dem Anlegen des QUEUED-Protokolls.
 */
export async function acquireManualSendLock(orgId: string, invoiceId: string): Promise<ManualSendLock | null> {
  const row = await dbInternal.invoiceAutoSend.findFirst({ where: { orgId, invoiceId }, select: { id: true, status: true } });
  if (!row) return null;
  if (row.status === "SENDING") throw new AutoSendRunningError();
  const prev = row.status;
  if (!(CLAIMABLE as readonly string[]).includes(prev)) return null;
  const upd = await dbInternal.invoiceAutoSend.updateMany({ where: { id: row.id, status: prev }, data: { status: MANUAL_PENDING } });
  if (upd.count === 0) {
    // Zustand hat sich zwischen Lesen und Sperren geaendert (z. B. Claim der Automatik): erneut entscheiden.
    const cur = await dbInternal.invoiceAutoSend.findFirst({ where: { id: row.id }, select: { status: true } });
    if (cur?.status === "SENDING") throw new AutoSendRunningError();
    return null;
  }
  return {
    async release(outcome) {
      if (outcome === "UNCLEAR") {
        await dbInternal.$transaction(async (tx) => {
          const upd = await tx.invoiceAutoSend.updateMany({
            where: { id: row.id, status: MANUAL_PENDING },
            data: { status: "UNCLEAR", lastError: "UNCLEAR_OUTCOME", nextAttemptAt: new Date(), claimToken: null },
          });
          if (upd.count > 0) await reportAutoSendProblemWithinTx(tx, row.id, "UNCLEAR", "UNCLEAR_OUTCOME", new Date());
        });
        return;
      }
      await dbInternal.invoiceAutoSend.updateMany({
        where: { id: row.id, status: MANUAL_PENDING },
        data: { status: outcome === "SENT" ? "DONE_MANUAL" : prev },
      });
    },
  };
}
