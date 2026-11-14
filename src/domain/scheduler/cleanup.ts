/**
 * Retention-Job "cleanup" (Fix-Welle Phase 10, Should-fix 7) — loescht Zeilen, die sonst
 * unbegrenzt wachsen:
 *
 * - `WebhookDelivery` im Endzustand (DELIVERED/DEAD), aelter als 90 Tage (`createdAt`) —
 *   ein Datensatz je Ereignis x Endpunkt, jeweils mit vollem Serializer-Schnappschuss in
 *   `dataJson` (final-review-findings.md #7).
 * - `ApiIdempotency`, aelter als 24h — das Ablaufverhalten in src/api/idempotency.ts ist
 *   rein lazy (eine Zeile wird nur geloescht, wenn GENAU IHR Schluessel erneut verwendet
 *   wird); ohne diesen Job bleibt jede einmal benutzte Idempotency-Key-Zeile fuer immer
 *   stehen, sobald sie nicht zufaellig wiederverwendet wird.
 * - `ApiRequestLog`, je Organisation nach `ApiSettings.retentionDays` (Default 7) **und**
 *   `maxRows` (Default 2000, die neuesten bleiben) — Phase 12d.
 *
 * - 17b: haengengebliebene QUEUED-EmailLogs (> 15 min) werden vorab auf FAILED abgeglichen.
 *
 * Laeuft als LETZTER Job (JOB_ORDER, src/domain/scheduler/runner.ts, nach "webhooks") —
 * raeumt damit nie eine Zeile weg, die derselbe Lauf gerade erst als faellig behandelt hat.
 */
import { dbInternal } from "@/lib/db";
import { purgeApiRequestLogs } from "@/domain/api-log/purge";
import { reconcileStaleQueuedEmails } from "@/domain/email/email-log";

export const WEBHOOK_DELIVERY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const API_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Abrufprotokoll des Kundenportals: 24 Monate (730 Tage). */
export const PORTAL_EVENT_RETENTION_MS = 730 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
  emailsReconciled: number;
  webhookDeliveriesDeleted: number;
  apiIdempotencyDeleted: number;
  apiRequestLogsDeleted: number;
  portalEventsDeleted: number;
  /** Abgelaufene Portal-Links, deren verschluesseltes Token geleert wurde. */
  portalTokensCleared: number;
}

export async function runCleanupJob(now: Date = new Date()): Promise<CleanupResult> {
  // Zuerst: haengengebliebene QUEUED-Mails auf FAILED (17b), vor dem Loeschen alter Zeilen.
  const emailsReconciled = await reconcileStaleQueuedEmails(now);
  const webhookThreshold = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_MS);
  const idempotencyThreshold = new Date(now.getTime() - API_IDEMPOTENCY_RETENTION_MS);

  const webhookDeliveries = await dbInternal.webhookDelivery.deleteMany({
    where: { status: { in: ["DELIVERED", "DEAD"] }, createdAt: { lt: webhookThreshold } },
  });
  const apiIdempotency = await dbInternal.apiIdempotency.deleteMany({
    where: { createdAt: { lt: idempotencyThreshold } },
  });
  const apiRequestLogsDeleted = await purgeApiRequestLogs(now);

  // Das Abrufprotokoll ist append-only (Guard); nur diese Aufbewahrungsloeschung nutzt dbInternal.
  const portalEvents = await dbInternal.customerPortalEvent.deleteMany({
    where: { at: { lt: new Date(now.getTime() - PORTAL_EVENT_RETENTION_MS) } },
  });

  // Abgelaufene Links: das wiederabrufbare Token wird nicht laenger gebraucht (nur Update, kein Loeschen).
  const portalTokens = await dbInternal.customerPortalLink.updateMany({
    where: { expiresAt: { lt: now }, tokenEnc: { not: "" } },
    data: { tokenEnc: "" },
  });

  return {
    emailsReconciled,
    webhookDeliveriesDeleted: webhookDeliveries.count,
    apiIdempotencyDeleted: apiIdempotency.count,
    apiRequestLogsDeleted,
    portalEventsDeleted: portalEvents.count,
    portalTokensCleared: portalTokens.count,
  };
}
