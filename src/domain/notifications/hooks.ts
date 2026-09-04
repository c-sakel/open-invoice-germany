/**
 * Ereignis-Hooks fuer Benachrichtigungen (Phase 8b, Task 3) — dedupliziert ueber
 * `createNotification` (dedupeKey), wird von den jeweiligen Ereignisquellen aufgerufen.
 * Alle Hooks sind fire-and-forget-tauglich: ein Fehler beim Erzeugen der Benachrichtigung
 * darf das ausloesende Ereignis nicht verhindern (gleiches Prinzip wie `logActivity`).
 */
import { createNotification } from "@/domain/notifications/create";

async function safeNotify(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("notifications hook: Erzeugen fehlgeschlagen", e);
  }
}

/** E-Mail-Versand als unzustellbar markiert (EmailLog.status = BOUNCED). */
export async function onEmailBounced(orgId: string, input: { logId: string; docType: string; docId: string; to?: string }): Promise<void> {
  await safeNotify(() =>
    createNotification({
      orgId,
      type: "EMAIL_BOUNCED",
      title: "E-Mail unzustellbar",
      body: input.to ? `Zustellung an ${input.to} fehlgeschlagen (${input.docType}).` : `Zustellung fehlgeschlagen (${input.docType}).`,
      entityType: input.docType,
      entityId: input.docId,
      dedupeKey: `EMAIL_BOUNCED:${input.logId}`,
    }),
  );
}

/** Ein Lauf einer wiederkehrenden Rechnung ist fehlgeschlagen (runDueRecurring, recurring/run.ts). */
export async function onRecurringFailed(orgId: string, input: { recurringId: string; title: string; message: string; at: Date }): Promise<void> {
  await safeNotify(() =>
    createNotification({
      orgId,
      type: "RECURRING_FAILED",
      title: `Abo "${input.title}" fehlgeschlagen`,
      body: input.message,
      entityType: "RECURRING",
      entityId: input.recurringId,
      dedupeKey: `RECURRING_FAILED:${input.recurringId}:${input.at.toISOString().slice(0, 10)}`,
      at: input.at,
    }),
  );
}

/** Eine erzeugte XRechnung/ZUGFeRD-XML besteht die EN-16931-Kernvalidierung nicht. */
export async function onEInvoiceInvalid(orgId: string, input: { invoiceId: string; errors: string[] }): Promise<void> {
  await safeNotify(() =>
    createNotification({
      orgId,
      type: "EINVOICE_INVALID",
      title: "E-Rechnung ungueltig",
      body: input.errors.slice(0, 5).join("; "),
      entityType: "INVOICE",
      entityId: input.invoiceId,
      dedupeKey: `EINVOICE_INVALID:${input.invoiceId}`,
    }),
  );
}
