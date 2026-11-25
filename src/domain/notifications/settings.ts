/**
 * Benachrichtigungs-Einstellungen je Organisation (Phase 8b, Task 3) — analog
 * `src/domain/dunning/settings.ts`: Selbstheilung PER CREATE, weil der Scheduler-Job
 * `notifications` (`job.ts`) beim Lauf eine tatsaechliche Zeile je Organisation braucht
 * (Digest-Zeitpunkt `lastDigestAt`), ein reiner In-Memory-Default reicht hier nicht.
 */
import { dbInternal } from "@/lib/db";

/** Benachrichtigungstypen (`Notification.type`) mit deutschem Anzeigetext (Task-3-Brief). */
export const NOTIFICATION_TYPES = {
  INVOICE_DUE_TODAY: "Rechnung heute faellig",
  INVOICE_OVERDUE: "Rechnung ueberfaellig",
  DUNNING_STAGE_REACHED: "Mahnstufe faellig",
  QUOTE_EXPIRING: "Angebot laeuft bald ab",
  EMAIL_BOUNCED: "E-Mail unzustellbar",
  RECURRING_FAILED: "Wiederkehrende Rechnung fehlgeschlagen",
  RECURRING_NOT_SENT: "Abo-Rechnung nicht versendet",
  EINVOICE_INVALID: "E-Rechnung ungueltig",
  ARCHIVE_TAMPERED: "Archivierter Beleg fehlt oder wurde veraendert",
  ARCHIVE_FAILED: "Archivierung fehlgeschlagen",
  CHAIN_BROKEN: "Aenderungsprotokoll: Hash-Kette gebrochen",
  FX_FETCH_FAILED: "Wechselkurs-Abruf fehlgeschlagen",
  OSS_THRESHOLD: "OSS-Schwelle (EU-Fernverkaeufe)",
  POSTAL_FAILED: "Postversand fehlgeschlagen",
  POSTAL_PENDING: "Post-Versand wartet auf Bestaetigung",
  DUNNING_NOT_SENT: "Mahnung nicht versendet",
  PAYMENT_RULE: "Regel nach Zahlungseingang",
  PAYMENT_RULE_FAILED: "Regel nach Zahlungseingang fehlgeschlagen",
  ONLINE_OVERPAYMENT: "Online-Zahlung hoeher als offener Betrag",
  ONLINE_PAYMENT_ISSUE: "Online-Zahlung pruefen",
  DATEV_LATE_ITEMS: "DATEV: Nachtraege in bereits exportierten Monaten",
  KU_THRESHOLD: "Kleinunternehmer-Umsatzgrenzen (§ 19 UStG)",
  INCOMING_DUE: "Eingangsrechnung faellig",
  INBOUND_MAIL_NEW: "Neue Belege im Postfach",
  INBOUND_MAIL_ERROR: "Postfach-Abruf gestört",
  BANK_FETCH_ACTION: "Kontoabruf braucht Ihre Freigabe",
  BANK_FETCH_ERROR: "Kontoabruf gestört",
  SCHEDULER_FAILED: "Hintergrundaufgabe fehlgeschlagen",
  WEBHOOK_DEAD: "Webhook endgültig nicht zugestellt",
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const ALL_NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPES) as NotificationType[];

/**
 * Phase 16a (Koordinator-Ruling): GoBD-Pflicht-Alarme — werden immer zugestellt, unabhaengig
 * von gespeicherten `enabledTypes` (auch fuer Bestandszeilen, die diese Typen nie kannten),
 * und sind in der Einstellungs-UI nicht abwaehlbar.
 */
export const MANDATORY_NOTIFICATION_TYPES: readonly NotificationType[] = ["ARCHIVE_TAMPERED", "ARCHIVE_FAILED", "CHAIN_BROKEN", "FX_FETCH_FAILED", "RECURRING_NOT_SENT", "SCHEDULER_FAILED"];

/**
 * Typen, die (bei aktivem `alarmEmail`) zusaetzlich sofort per E-Mail gemeldet werden: Pflicht-Alarme
 * plus Zustell-/Betriebsstoerungen.
 */
export const ALARM_MAIL_TYPES: readonly NotificationType[] = [
  ...MANDATORY_NOTIFICATION_TYPES,
  "RECURRING_FAILED",
  "WEBHOOK_DEAD",
  "EMAIL_BOUNCED",
  "DUNNING_NOT_SENT",
  "POSTAL_FAILED",
];

export function isMandatoryNotificationType(type: NotificationType): boolean {
  return MANDATORY_NOTIFICATION_TYPES.includes(type);
}

function withMandatory(types: NotificationType[]): NotificationType[] {
  return ALL_NOTIFICATION_TYPES.filter((t) => types.includes(t) || isMandatoryNotificationType(t));
}

export interface NotificationSettingsValue {
  enabledTypes: NotificationType[];
  emailDigest: boolean;
  lastDigestAt: Date | null;
  alarmEmail: boolean;
  lastAlarmMailAt: Date | null;
}

function toValue(row: { enabledTypesJson: string; emailDigest: boolean; lastDigestAt: Date | null; alarmEmail: boolean; lastAlarmMailAt: Date | null }): NotificationSettingsValue {
  return {
    enabledTypes: parseEnabledTypes(row.enabledTypesJson),
    emailDigest: row.emailDigest,
    lastDigestAt: row.lastDigestAt,
    alarmEmail: row.alarmEmail,
    lastAlarmMailAt: row.lastAlarmMailAt,
  };
}

function parseEnabledTypes(json: string): NotificationType[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [...ALL_NOTIFICATION_TYPES];
    return withMandatory(parsed.filter((t): t is NotificationType => ALL_NOTIFICATION_TYPES.includes(t)));
  } catch {
    return [...ALL_NOTIFICATION_TYPES];
  }
}

/**
 * Laedt die Benachrichtigungs-Einstellungen einer Organisation; legt sie mit Defaults
 * (alle Typen aktiv, Digest aus) an, wenn noch keine Zeile existiert (Selbstheilung,
 * upsert statt find+create wegen Nebenlaeufigkeit).
 */
export async function loadNotificationSettings(orgId: string): Promise<NotificationSettingsValue> {
  const existing = await dbInternal.notificationSettings.findUnique({ where: { orgId } });
  if (existing) {
    return toValue(existing);
  }
  const row = await dbInternal.notificationSettings.upsert({
    where: { orgId },
    create: { orgId, enabledTypesJson: JSON.stringify(ALL_NOTIFICATION_TYPES), emailDigest: false },
    update: {},
  });
  return toValue(row);
}

export interface SaveNotificationSettingsInput {
  enabledTypes: NotificationType[];
  emailDigest: boolean;
  /** Alarme sofort per E-Mail; fehlt der Wert, bleibt die Einstellung unveraendert. */
  alarmEmail?: boolean;
}

/** Speichert die Benachrichtigungs-Einstellungen (Upsert, da anfangs keine Zeile existiert). */
export async function saveNotificationSettings(orgId: string, input: SaveNotificationSettingsInput): Promise<NotificationSettingsValue> {
  const enabledTypesJson = JSON.stringify(withMandatory(input.enabledTypes.filter((t) => ALL_NOTIFICATION_TYPES.includes(t))));
  const row = await dbInternal.notificationSettings.upsert({
    where: { orgId },
    create: { orgId, enabledTypesJson, emailDigest: input.emailDigest, ...(input.alarmEmail === undefined ? {} : { alarmEmail: input.alarmEmail }) },
    update: { enabledTypesJson, emailDigest: input.emailDigest, ...(input.alarmEmail === undefined ? {} : { alarmEmail: input.alarmEmail }) },
  });
  return toValue(row);
}

/** Setzt `lastDigestAt` nach einem erfolgreich versendeten Digest (job.ts). */
export async function markDigestSent(orgId: string, at: Date): Promise<void> {
  await dbInternal.notificationSettings.update({ where: { orgId }, data: { lastDigestAt: at } });
}
