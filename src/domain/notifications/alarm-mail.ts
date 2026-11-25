/**
 * Alarm-Mail: meldet neue Alarme (`ALARM_MAIL_TYPES`) sofort per E-Mail an die Firmenadresse,
 * hoechstens einmal je Stunde und je Alarm hoechstens einmal. Der Alarm wird VOR dem Versand
 * beansprucht (`alarmMailedAt`, `lastAlarmMailAt` in einer Transaktion); scheitert der Versand,
 * bleibt der Alarm in der App und in der Tagesuebersicht, es entsteht keine neue Benachrichtigung
 * (keine Schleife). Kein Servertext, keine internen Notizen, kein EmailLog.
 * Der Text nennt je Typ nur die feste Bezeichnung aus `NOTIFICATION_TYPES` und die Anzahl, dazu einen
 * Link auf die Benachrichtigungen; nie freie Titel, Kunden- oder Belegdaten. Scheitert der Versand
 * sicher (`MailSendError` mit `NOT_SENT`), werden Claim und Takt zurueckgesetzt, damit der naechste
 * Lauf es erneut versucht; bei unklarem Ausgang bleibt der Alarm als gemailt markiert.
 */
import { dbInternal } from "@/lib/db";
import { loadBrand } from "@/domain/settings/brand";
import { loadMailSettings } from "@/domain/email/settings";
import { withHtmlPart } from "@/domain/email/html-part";
import { createSmtpProvider } from "@/lib/mail/smtp";
import type { MailProvider } from "@/lib/mail/provider";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { MailSendError } from "@/lib/mail/provider";
import { ALARM_MAIL_TYPES, NOTIFICATION_TYPES, loadNotificationSettings, type NotificationType } from "@/domain/notifications/settings";

const HOUR_MS = 60 * 60 * 1000;
export const ALARM_MAIL_MIN_INTERVAL_MS = HOUR_MS;
export const ALARM_MAIL_MAX_AGE_MS = 48 * HOUR_MS;
const ALARM_MAIL_BATCH = 20;

/** Versendet faellige Alarme einer Organisation; liefert die Zahl der gemailten Alarme. Wirft nie bei Versandfehlern. */
export async function sendAlarmMailIfDue(orgId: string, now: Date, provider?: MailProvider): Promise<number> {
  const settings = await loadNotificationSettings(orgId);
  if (!settings.alarmEmail) return 0;
  const intervalStart = new Date(now.getTime() - ALARM_MAIL_MIN_INTERVAL_MS);
  if (settings.lastAlarmMailAt && settings.lastAlarmMailAt > intervalStart) return 0;

  const mailSettings = await loadMailSettings(orgId);
  if (!mailSettings) return 0;

  const candidates = await dbInternal.notification.findMany({
    where: {
      orgId,
      type: { in: [...ALARM_MAIL_TYPES] },
      alarmMailedAt: null,
      readAt: null,
      createdAt: { gte: new Date(now.getTime() - ALARM_MAIL_MAX_AGE_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: ALARM_MAIL_BATCH,
    select: { id: true },
  });
  if (candidates.length === 0) return 0;
  const ids = candidates.map((c) => c.id);

  // Beanspruchen vor dem Versand: Takt und Alarme atomar; wer den Takt nicht erhaelt, sendet nichts.
  const previousSlot = settings.lastAlarmMailAt;
  const claimed = await dbInternal.$transaction(async (tx) => {
    const slot = await tx.notificationSettings.updateMany({
      where: { orgId, OR: [{ lastAlarmMailAt: null }, { lastAlarmMailAt: { lte: intervalStart } }] },
      data: { lastAlarmMailAt: now },
    });
    if (slot.count === 0) return [];
    await tx.notification.updateMany({ where: { orgId, id: { in: ids }, alarmMailedAt: null }, data: { alarmMailedAt: now } });
    return tx.notification.findMany({
      where: { orgId, id: { in: ids }, alarmMailedAt: now },
      orderBy: { createdAt: "asc" },
      select: { id: true, type: true },
    });
  });
  if (claimed.length === 0) return 0;

  try {
    const org = await dbInternal.organization.findUnique({ where: { id: orgId }, select: { email: true } });
    const to = org?.email || mailSettings.fromEmail;
    const prov = provider ?? createSmtpProvider(mailSettings);
    const brand = await loadBrand(orgId);
    const base = appBaseUrlFromEnv();
    const counts = new Map<string, number>();
    for (const n of claimed) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    const lines = [...counts.entries()].map(([type, n]) => {
      const label = type in NOTIFICATION_TYPES ? NOTIFICATION_TYPES[type as NotificationType] : "Alarm";
      return `- ${label}${n > 1 ? ` (${n}x)` : ""}`;
    });
    const linkLine = base ? `\n\nDetails: ${base}/benachrichtigungen` : "";
    await prov.send(
      await withHtmlPart(orgId, mailSettings, {
        from: { name: mailSettings.fromName, address: mailSettings.fromEmail },
        to: [to],
        cc: [],
        bcc: [],
        replyTo: mailSettings.replyTo ?? undefined,
        subject: `Alarm: ${claimed.length} Meldung(en) – ${brand.appName}`,
        text: `${claimed.length} neue Alarm-Meldung(en):\n\n${lines.join("\n")}${linkLine}`,
        attachments: [],
      }),
    );
    return claimed.length;
  } catch (e) {
    console.error("Alarm-Mail: Versand fehlgeschlagen", e instanceof Error ? e.name : "Fehler");
    if (e instanceof MailSendError && e.outcome === "NOT_SENT") await releaseClaim(orgId, claimed.map((c) => c.id), now, previousSlot);
    return 0;
  }
}

/** Nimmt Claim und Takt zurueck (nur wenn unveraendert von diesem Lauf gesetzt), damit der naechste Lauf erneut versucht. */
async function releaseClaim(orgId: string, ids: string[], now: Date, previousSlot: Date | null): Promise<void> {
  try {
    await dbInternal.$transaction(async (tx) => {
      await tx.notification.updateMany({ where: { orgId, id: { in: ids }, alarmMailedAt: now }, data: { alarmMailedAt: null } });
      await tx.notificationSettings.updateMany({ where: { orgId, lastAlarmMailAt: now }, data: { lastAlarmMailAt: previousSlot } });
    });
  } catch (e) {
    console.error("Alarm-Mail: Zuruecksetzen fehlgeschlagen", e instanceof Error ? e.name : "Fehler");
  }
}
