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

/** Manueller Versand wird abgelehnt, solange die Automatik diese Rechnung gerade versendet (Status SENDING). */
export async function assertNoAutoSendRunning(orgId: string, invoiceId: string): Promise<void> {
  const running = await dbInternal.invoiceAutoSend.findFirst({ where: { orgId, invoiceId, status: "SENDING" }, select: { id: true } });
  if (running) throw new AutoSendRunningError();
}
