/**
 * Ereignis-Hooks fuer Benachrichtigungen (Phase 8b, Task 3) — dedupliziert ueber
 * `createNotification` (dedupeKey), wird von den jeweiligen Ereignisquellen aufgerufen.
 * Alle Hooks sind fire-and-forget-tauglich: ein Fehler beim Erzeugen der Benachrichtigung
 * darf das ausloesende Ereignis nicht verhindern (gleiches Prinzip wie `logActivity`).
 *
 * Fix-Welle (S4): vorher pruefte NUR `job.ts` (die drei Scheduler-generierten Typen
 * INVOICE_DUE_TODAY/DUNNING_STAGE_REACHED/QUOTE_EXPIRING) `enabledTypes` — diese drei
 * ereignisgetriebenen Hooks ignorierten die Einstellung komplett, obwohl
 * /einstellungen/benachrichtigungen alle sieben Typen als abschaltbar anbietet. Jeder
 * Hook laedt jetzt selbst `loadNotificationSettings` und ueberspringt die Benachrichtigung,
 * wenn ihr Typ deaktiviert ist (Selbstheilung inklusive, wie beim Scheduler-Job).
 */
import { dbInternal } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { buyerSnapshotSchema } from "@/schemas";
import { isOssBuyer } from "@/domain/reporting/oss-calc";
import { checkOssNotifications } from "@/domain/reporting/oss-notify";
import { checkKuNotifications } from "@/domain/reporting/ku-notify";
import { createNotification } from "@/domain/notifications/create";
import { berlinDateKey } from "@/lib/berlin-time";
import { isMandatoryNotificationType, loadNotificationSettings, type NotificationType } from "@/domain/notifications/settings";

async function safeNotify(orgId: string, type: NotificationType, fn: () => Promise<unknown>): Promise<void> {
  try {
    // Pflicht-Alarme (Phase 16a) umgehen den Einstellungsfilter.
    if (!isMandatoryNotificationType(type)) {
      const settings = await loadNotificationSettings(orgId);
      if (!settings.enabledTypes.includes(type)) return;
    }
    await fn();
  } catch (e) {
    console.error("notifications hook: Erzeugen fehlgeschlagen", e);
  }
}

/**
 * E-Mail-Versand als unzustellbar markiert (EmailLog.status = BOUNCED). Erzeuger ist
 * `markEmailBounced` (email-log.ts), aufgerufen von `applyBounce` (domain/email/bounce.ts), wenn ein
 * Zustellbericht (RFC 3464) im abgerufenen Postfach ankommt (domain/mailbox/fetch.ts).
 */
export async function onEmailBounced(orgId: string, input: { logId: string; docType: string; docId: string; to?: string }): Promise<void> {
  await safeNotify(orgId, "EMAIL_BOUNCED", () =>
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
  await safeNotify(orgId, "RECURRING_FAILED", () =>
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

/**
 * Abo-Rechnung wurde nicht (oder unklar) automatisch versendet (auto-send.ts). Pflicht-Alarm: umgeht den
 * Einstellungsfilter. Text nur aus festen Bausteinen und der Belegnummer, nie mit Servertext.
 */
export async function notifyRecurringNotSentWithinTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  input: { invoiceId: string; number: string | null; status: "NO_ADDRESS" | "UNCLEAR" | "GAVE_UP" | "BOUNCED"; cycle: number; at: Date },
): Promise<void> {
  const what = input.number ? `Rechnung ${input.number}` : "Rechnung";
  const body =
    input.status === "NO_ADDRESS"
      ? `${what}: Der Kunde hat keine E-Mail-Adresse. Der Versand wird bis zu 7 Tage lang erneut geprüft.`
      : input.status === "UNCLEAR"
        ? `${what}: Ob die E-Mail angekommen ist, ist unklar. Es wird nicht automatisch erneut gesendet. Bitte prüfen und bei Bedarf manuell senden.`
        : input.status === "BOUNCED"
          ? `${what}: Die E-Mail ist laut Zustellbericht nicht angekommen (unzustellbar). Bitte die Adresse prüfen und manuell senden.`
          : `${what}: Der automatische Versand wurde aufgegeben. Bitte manuell senden.`;
  // Schluessel je Neustart-Zyklus: nach `retryAutoSend` meldet ein erneutes UNCLEAR/GAVE_UP wieder.
  const dedupeKey = `RECURRING_NOT_SENT:${input.invoiceId}:${input.status}:${input.cycle}`;
  const existing = await tx.notification.findFirst({ where: { orgId, dedupeKey }, select: { id: true } });
  if (existing) return;
  await tx.notification.create({
    data: {
      orgId,
      type: "RECURRING_NOT_SENT",
      title: "Abo-Rechnung nicht versendet",
      body,
      link: `/rechnungen/${input.invoiceId}`,
      entityType: "INVOICE",
      entityId: input.invoiceId,
      createdAt: input.at,
      dedupeKey,
    },
    select: { id: true },
  });
}

/** Sammelrechnung nicht moeglich: die Abos der Gruppe wurden einzeln abgerechnet. */
export async function onCollectiveFallback(orgId: string, input: { recurringId: string; memberCount: number; message: string; at: Date }): Promise<void> {
  await safeNotify(orgId, "RECURRING_FAILED", () =>
    createNotification({
      orgId,
      type: "RECURRING_FAILED",
      title: "Sammelrechnung nicht moeglich – Abos einzeln abgerechnet",
      body: `${input.memberCount} Abos wurden einzeln abgerechnet. Grund: ${input.message}`,
      entityType: "RECURRING",
      entityId: input.recurringId,
      dedupeKey: `COLLECTIVE_FALLBACK:${input.recurringId}:${input.at.toISOString().slice(0, 10)}`,
      at: input.at,
    }),
  );
}

/** Eine erzeugte XRechnung/ZUGFeRD-XML besteht die EN-16931-Kernvalidierung nicht. */
export async function onEInvoiceInvalid(orgId: string, input: { invoiceId: string; errors: string[] }): Promise<void> {
  await safeNotify(orgId, "EINVOICE_INVALID", () =>
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

/**
 * Phase 16a (Belegarchiv): eine archivierte Belegdatei fehlt oder ihr SHA-256 weicht ab.
 * Dedupliziert je Rechnung, Dateiart und Tag — wiederholte Abrufe erzeugen keine Flut, ein
 * erneuter Verlust nach einer Wiederherstellung meldet sich aber wieder.
 */
export async function onArchiveTampered(orgId: string, input: { invoiceId: string; kind: string; at?: Date }): Promise<void> {
  const at = input.at ?? new Date();
  await safeNotify(orgId, "ARCHIVE_TAMPERED", () =>
    createNotification({
      orgId,
      type: "ARCHIVE_TAMPERED",
      title: "Archivierter Beleg fehlt oder wurde veraendert",
      body: `Die archivierte ${input.kind}-Datei der Rechnung ist nicht mehr unveraendert vorhanden. Der Beleg wird nicht neu erzeugt; bitte aus der Sicherung wiederherstellen.`,
      entityType: "INVOICE",
      entityId: input.invoiceId,
      dedupeKey: `ARCHIVE_TAMPERED:${input.invoiceId}:${input.kind}:${at.toISOString().slice(0, 10)}`,
      at,
    }),
  );
}

/**
 * Eine archivierte Datei einer Eingangsrechnung fehlt oder weicht vom gespeicherten SHA-256 ab.
 * Dedupliziert je Eingangsrechnung, Dateiart und Tag.
 */
export async function onIncomingArchiveTampered(
  orgId: string,
  input: { incomingInvoiceId: string; kind: string; at?: Date },
): Promise<void> {
  const at = input.at ?? new Date();
  await safeNotify(orgId, "ARCHIVE_TAMPERED", () =>
    createNotification({
      orgId,
      type: "ARCHIVE_TAMPERED",
      title: "Archivierte Eingangsrechnung fehlt oder wurde veraendert",
      body: `Die archivierte Datei (${input.kind}) einer Eingangsrechnung ist nicht mehr unveraendert vorhanden. Sie wird nicht ausgegeben; bitte aus der Sicherung wiederherstellen.`,
      link: `/eingang/${input.incomingInvoiceId}`,
      entityType: "INCOMING_INVOICE",
      entityId: input.incomingInvoiceId,
      dedupeKey: `ARCHIVE_TAMPERED:incoming:${input.incomingInvoiceId}:${input.kind}:${at.toISOString().slice(0, 10)}`,
      at,
    }),
  );
}

/** Phase 16a (Belegarchiv): Erzeugen oder Ablegen der Archivdateien ist fehlgeschlagen. */
export async function onArchiveFailed(orgId: string, input: { invoiceId: string; message: string; at: Date }): Promise<void> {
  await safeNotify(orgId, "ARCHIVE_FAILED", () =>
    createNotification({
      orgId,
      type: "ARCHIVE_FAILED",
      title: "Archivierung fehlgeschlagen",
      body: input.message,
      entityType: "INVOICE",
      entityId: input.invoiceId,
      dedupeKey: `ARCHIVE_FAILED:${input.invoiceId}:${input.at.toISOString().slice(0, 10)}`,
      at: input.at,
    }),
  );
}

/** Phase 16a (Kettenpruefung): das Aenderungsprotokoll einer Organisation ist nicht mehr lueckenlos verkettet. */
export async function onChainBroken(orgId: string, input: { brokenEntryId: number; at: Date }): Promise<void> {
  await safeNotify(orgId, "CHAIN_BROKEN", () =>
    createNotification({
      orgId,
      type: "CHAIN_BROKEN",
      title: "Aenderungsprotokoll: Hash-Kette gebrochen",
      body: `Eintrag ${input.brokenEntryId} passt nicht zur Hash-Kette.`,
      entityType: "CHANGELOG",
      entityId: String(input.brokenEntryId),
      dedupeKey: `CHAIN_BROKEN:${input.brokenEntryId}`,
      at: input.at,
    }),
  );
}

/**
 * Phase 16e: eine Rechnung wurde festgeschrieben. Nur bei einem OSS-Kaeufer (EU-Privatkunde laut
 * Snapshot) wird die Schwelle neu ausgewertet. Fehler werden geloggt, nie geworfen; aufzurufen
 * erst nach dem Commit der Festschreibung.
 */
export async function onInvoiceFinalizedOss(orgId: string, invoiceId: string, now: Date = new Date()): Promise<void> {
  try {
    const inv = await dbInternal.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { buyerSnapshotJson: true } });
    if (!inv?.buyerSnapshotJson) return;
    const parsed = buyerSnapshotSchema.safeParse(JSON.parse(inv.buyerSnapshotJson));
    if (!parsed.success || !isOssBuyer({ countryCode: parsed.data.countryCode, vatId: parsed.data.vatId })) return;
  } catch (e) {
    console.error("notifications hook: OSS-Pruefung fehlgeschlagen", e);
    return;
  }
  await safeNotify(orgId, "OSS_THRESHOLD", () => checkOssNotifications(orgId, now));
}

/**
 * Eine Rechnung wurde festgeschrieben: Umsatzgrenzen der Kleinunternehmerregelung neu auswerten.
 * Fehler werden geloggt, nie geworfen; aufzurufen erst nach dem Commit.
 */
export async function onInvoiceFinalizedKu(orgId: string, now: Date = new Date()): Promise<void> {
  await safeNotify(orgId, "KU_THRESHOLD", () => checkKuNotifications(orgId, now));
}

/** Eine Zahlung oder Gegenbuchung wurde festgeschrieben: Umsatzgrenzen neu auswerten (nach dem Commit). */
export async function onPaymentChangedKu(orgId: string, now: Date = new Date()): Promise<void> {
  await safeNotify(orgId, "KU_THRESHOLD", () => checkKuNotifications(orgId, now));
}

/** Ein Regel-Lauf nach Zahlungseingang ist endgueltig fehlgeschlagen. */
export async function onPaymentRuleFailed(
  orgId: string,
  input: { runId: string; ruleName: string; invoiceId: string; invoiceNumber: string | null; message: string; at: Date },
): Promise<void> {
  await safeNotify(orgId, "PAYMENT_RULE_FAILED", () =>
    createNotification({
      orgId,
      type: "PAYMENT_RULE_FAILED",
      title: `Regel "${input.ruleName}" fehlgeschlagen${input.invoiceNumber ? ` (${input.invoiceNumber})` : ""}`,
      body: input.message,
      link: `/rechnungen/${input.invoiceId}`,
      entityType: "INVOICE",
      entityId: input.invoiceId,
      dedupeKey: `payment-rule-failed:${input.runId}`,
      at: input.at,
    }),
  );
}

export interface OnlinePaymentNotice {
  type: "ONLINE_OVERPAYMENT" | "ONLINE_PAYMENT_ISSUE";
  title: string;
  body: string;
  invoiceId?: string;
  dedupeKey: string;
  at: Date;
}

/** Online-Zahlung: Hinweis ausserhalb einer Transaktion (Fehler werden geloggt, nie geworfen). */
export async function onOnlinePaymentNotice(orgId: string, input: OnlinePaymentNotice): Promise<void> {
  await safeNotify(orgId, input.type, () =>
    createNotification({
      orgId,
      type: input.type,
      title: input.title,
      body: input.body,
      ...(input.invoiceId ? { link: `/rechnungen/${input.invoiceId}`, entityType: "INVOICE", entityId: input.invoiceId } : {}),
      dedupeKey: input.dedupeKey,
      at: input.at,
    }),
  );
}

/**
 * Online-Zahlung: Hinweis in der Buchungstransaktion (nur `tx`, kein zweiter Datenbankzugriff). Beachtet die
 * Einstellung der Organisation; ein vorhandener Dedupe-Schluessel erzeugt nichts. Kein P2002-Fehler in der Transaktion:
 * die Pruefung liegt unter der Rechnungssperre und der Schluessel ist je Ereignis eindeutig.
 */
export async function notifyOnlinePaymentWithinTx(tx: Prisma.TransactionClient, orgId: string, input: OnlinePaymentNotice): Promise<void> {
  const settings = await tx.notificationSettings.findUnique({ where: { orgId }, select: { enabledTypesJson: true } });
  if (settings) {
    try {
      const parsed: unknown = JSON.parse(settings.enabledTypesJson);
      if (Array.isArray(parsed) && !parsed.includes(input.type)) return;
    } catch {
      // kaputte Einstellung: wie Standard (alle aktiv)
    }
  }
  const existing = await tx.notification.findFirst({ where: { orgId, dedupeKey: input.dedupeKey }, select: { id: true } });
  if (existing) return;
  await tx.notification.create({
    data: {
      orgId,
      type: input.type,
      title: input.title,
      body: input.body,
      link: input.invoiceId ? `/rechnungen/${input.invoiceId}` : null,
      entityType: input.invoiceId ? "INVOICE" : null,
      entityId: input.invoiceId ?? null,
      createdAt: input.at,
      dedupeKey: input.dedupeKey,
    },
    select: { id: true },
  });
}

/**
 * Hintergrundaufgabe zweimal hintereinander fehlgeschlagen (scheduler/runner.ts). Pflicht-Alarm fuer JEDE
 * Organisation (der Lauf ist instanzweit), eine Meldung je Aufgabe und Berliner Tag. Nur feste Bausteine,
 * nie Servertext.
 */
export async function onSchedulerFailed(job: string, runId: string, at: Date): Promise<void> {
  try {
    const orgs = await dbInternal.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      await safeNotify(org.id, "SCHEDULER_FAILED", () =>
        createNotification({
          orgId: org.id,
          type: "SCHEDULER_FAILED",
          title: `Hintergrundaufgabe "${job}" fehlgeschlagen`,
          body: "Die Aufgabe ist zweimal hintereinander fehlgeschlagen. Details unter Einstellungen, Automatisierung.",
          link: "/einstellungen/automatisierung",
          entityType: "SCHEDULER_RUN",
          entityId: runId,
          dedupeKey: `SCHEDULER_FAILED:${job}:${berlinDateKey(at)}`,
          at,
        }),
      );
    }
  } catch (e) {
    console.error("notifications hook: SCHEDULER_FAILED fehlgeschlagen", e);
  }
}

/** Webhook-Zustellung endgueltig gescheitert (DEAD). Eine Meldung je Endpunkt und Berliner Tag. */
export async function onWebhookDead(orgId: string, input: { endpointId: string; deliveryId: string; event: string; at: Date }): Promise<void> {
  await safeNotify(orgId, "WEBHOOK_DEAD", () =>
    createNotification({
      orgId,
      type: "WEBHOOK_DEAD",
      title: "Webhook endgültig nicht zugestellt",
      body: `Ereignis ${input.event} konnte nicht zugestellt werden. Das Zustellprotokoll zeigt den Grund.`,
      link: "/einstellungen/webhooks",
      entityType: "WEBHOOK_DELIVERY",
      entityId: input.deliveryId,
      dedupeKey: `WEBHOOK_DEAD:${input.endpointId}:${berlinDateKey(input.at)}`,
      at: input.at,
    }),
  );
}
