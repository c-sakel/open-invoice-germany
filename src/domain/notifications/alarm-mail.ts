/**
 * Alarm-Mail: meldet neue Alarme (`ALARM_MAIL_TYPES`) sofort per E-Mail an die Firmenadresse,
 * hoechstens einmal je Stunde und je Alarm hoechstens einmal. Der Alarm wird VOR dem Versand
 * beansprucht (`alarmMailedAt`, `lastAlarmMailAt` in einer Transaktion); scheitert der Versand,
 * bleibt der Alarm in der App und in der Tagesuebersicht, es entsteht keine neue Benachrichtigung
 * (keine Schleife). Kein Servertext, keine internen Notizen, kein EmailLog.
 */
import { dbInternal } from "@/lib/db";
import { loadBrand } from "@/domain/settings/brand";
import { loadMailSettings } from "@/domain/email/settings";
import { withHtmlPart } from "@/domain/email/html-part";
import { createSmtpProvider } from "@/lib/mail/smtp";
import type { MailProvider } from "@/lib/mail/provider";
import { appBaseUrlFromEnv } from "@/lib/http/base-url";
import { ALARM_MAIL_TYPES, loadNotificationSettings } from "@/domain/notifications/settings";

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
      select: { title: true, link: true },
    });
  });
  if (claimed.length === 0) return 0;

  try {
    const org = await dbInternal.organization.findUnique({ where: { id: orgId }, select: { email: true } });
    const to = org?.email || mailSettings.fromEmail;
    const prov = provider ?? createSmtpProvider(mailSettings);
    const brand = await loadBrand(orgId);
    const base = appBaseUrlFromEnv();
    const lines = claimed.map((n) => `- ${n.title}${base && n.link ? `\n  ${base}${n.link}` : ""}`);
    await prov.send(
      await withHtmlPart(orgId, mailSettings, {
        from: { name: mailSettings.fromName, address: mailSettings.fromEmail },
        to: [to],
        cc: [],
        bcc: [],
        replyTo: mailSettings.replyTo ?? undefined,
        subject: `Alarm: ${claimed.length} Meldung(en) – ${brand.appName}`,
        text: `${claimed.length} neue Alarm-Meldung(en):\n\n${lines.join("\n")}`,
        attachments: [],
      }),
    );
    return claimed.length;
  } catch (e) {
    console.error("Alarm-Mail: Versand fehlgeschlagen", e instanceof Error ? e.name : "Fehler");
    return 0;
  }
}
