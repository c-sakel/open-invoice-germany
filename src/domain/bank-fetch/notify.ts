/**
 * Benachrichtigungen des Kontoabrufs. Titel und Texte sind fest; sie nennen weder Bank noch IBAN noch Kennung.
 * Ein Eintrag je Zugang, Anlass und Tag (Berliner Kalendertag), damit der Job nicht jede Stunde dieselbe Meldung erzeugt.
 */
import { berlinDateKey, berlinMidnight, berlinParts } from "@/lib/berlin-time";
import { dbInternal } from "@/lib/db";
import { createNotification } from "@/domain/notifications/create";
import { loadNotificationSettings } from "@/domain/notifications/settings";

const LINK = "/einstellungen/kontoabruf";

export type FetchActionKind = "SCA" | "PIN" | "SCA_RENEW";

const ACTION_TITLES: Record<FetchActionKind, string> = {
  SCA: "Der automatische Kontoabruf braucht eine Freigabe. Bitte den Abruf einmal von Hand ausfuehren.",
  PIN: "Die Bank hat die Anmeldung beim Kontoabruf abgelehnt. Der automatische Abruf ist ausgeschaltet. Bitte die Zugangsdaten pruefen.",
  SCA_RENEW: "Die starke Freigabe fuer den Kontoabruf laeuft bald ab. Bitte den Abruf in den naechsten Tagen von Hand ausfuehren.",
};

async function enabled(orgId: string, type: "BANK_FETCH_ACTION" | "BANK_FETCH_ERROR"): Promise<boolean> {
  const s = await loadNotificationSettings(orgId);
  return s.enabledTypes.includes(type);
}

/** `dayKey`: bei SCA/PIN der Berliner Tag der Meldung, bei SCA_RENEW der Tag der letzten Freigabe. */
export async function notifyFetchAction(orgId: string, connectionId: string, kind: FetchActionKind, now: Date, lastScaAt?: Date | null): Promise<void> {
  try {
    if (!(await enabled(orgId, "BANK_FETCH_ACTION"))) return;
    const dedupeKey =
      kind === "SCA_RENEW"
        ? `BANK_FETCH_SCA_RENEW:${connectionId}:${lastScaAt ? berlinDateKey(lastScaAt) : "unbekannt"}`
        : `BANK_FETCH_ACTION:${kind}:${connectionId}:${berlinDateKey(now)}`;
    await createNotification({ orgId, type: "BANK_FETCH_ACTION", title: ACTION_TITLES[kind], link: LINK, entityType: "BANK_CONNECTION", entityId: connectionId, dedupeKey, at: now });
  } catch (e) {
    console.error("Kontoabruf: Meldung nicht angelegt", e instanceof Error ? e.name : "unbekannt");
  }
}

/** War der letzte Abrufversuch vor heute ein Fehlschlag? Dann ist heute der zweite Fehltag in Folge. */
export async function previousDayFailed(orgId: string, connectionId: string, now: Date): Promise<boolean> {
  const { year, month, day } = berlinParts(now);
  const last = await dbInternal.bankFetchRun.findFirst({
    where: { orgId, connectionId, startedAt: { lt: berlinMidnight(year, month, day) } },
    orderBy: { startedAt: "desc" },
    select: { result: true },
  });
  return last !== null && last.result !== "OK";
}

/** Fehlermeldung je Code und Tag, erst ab dem zweiten Fehltag in Folge. */
export async function notifyFetchError(orgId: string, connectionId: string, code: string, now: Date): Promise<void> {
  try {
    if (!(await enabled(orgId, "BANK_FETCH_ERROR"))) return;
    if (!(await previousDayFailed(orgId, connectionId, now))) return;
    await createNotification({
      orgId,
      type: "BANK_FETCH_ERROR",
      title: `Der automatische Kontoabruf schlaegt seit dem Vortag fehl (Code ${code}). Bitte den Zugang pruefen.`,
      link: LINK,
      entityType: "BANK_CONNECTION",
      entityId: connectionId,
      dedupeKey: `BANK_FETCH_ERROR:${connectionId}:${code}:${berlinDateKey(now)}`,
      at: now,
    });
  } catch (e) {
    console.error("Kontoabruf: Meldung nicht angelegt", e instanceof Error ? e.name : "unbekannt");
  }
}
