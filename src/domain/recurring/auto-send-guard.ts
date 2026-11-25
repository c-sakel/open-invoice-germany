/**
 * Abgrenzung Automatik/manueller Versand (klein gehalten, damit `email/send.ts` ohne Zyklus darauf zugreifen kann).
 */
import { dbInternal } from "@/lib/db";

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

export interface ManualSendLock {
  /** Nach dem Versuch: SENT -> DONE_MANUAL, sonst Rueckkehr in den vorherigen Zustand (nur wenn noch gesperrt). */
  release(outcome: "SENT" | "NOT_SENT"): Promise<void>;
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
      await dbInternal.invoiceAutoSend.updateMany({
        where: { id: row.id, status: MANUAL_PENDING },
        data: { status: outcome === "SENT" ? "DONE_MANUAL" : prev },
      });
    },
  };
}
