/**
 * Scheduler-Job: ruft die Postfaecher aller eingeschalteten Firmen seriell ab und raeumt danach die Zwischenablage auf.
 * Summary und Fehler enthalten nur Zahlen und feste Codes.
 */
import { dbInternal } from "@/lib/db";
import type { MailboxClient } from "@/lib/mailbox/client";
import { withJobLock } from "@/domain/scheduler/lock";
import { fetchMailboxForOrg } from "./fetch";
import { purgeMailboxStaging } from "./purge";

export interface FetchSummary {
  orgs: number;
  messages: number;
  staged: number;
  skipped: number;
  errors: number;
}

export async function runMailboxJob(now: Date, client?: MailboxClient): Promise<FetchSummary> {
  const summary: FetchSummary = { orgs: 0, messages: 0, staged: 0, skipped: 0, errors: 0 };
  const active = await dbInternal.inboundMailboxSettings.findMany({ where: { enabled: true }, select: { orgId: true }, orderBy: { orgId: "asc" } });
  for (const { orgId } of active) {
    summary.orgs += 1;
    try {
      const r = await fetchMailboxForOrg(orgId, now, client);
      summary.messages += r.messages;
      summary.staged += r.staged;
      if (r.error !== null) summary.errors += 1;
    } catch (e) {
      summary.errors += 1;
      console.error("Postfach-Abruf fehlgeschlagen", e instanceof Error ? e.name : "unbekannt");
    }
  }
  const withSettings = await dbInternal.inboundMailboxSettings.findMany({ select: { orgId: true }, orderBy: { orgId: "asc" } });
  for (const { orgId } of withSettings) {
    try {
      await purgeMailboxStaging(orgId, now);
    } catch (e) {
      summary.errors += 1;
      console.error("Postfach-Aufraeumen fehlgeschlagen", e instanceof Error ? e.name : "unbekannt");
    }
  }
  return summary;
}

/**
 * Manueller Abruf nur der eigenen Firma (kein anderer Job, keine anderen Firmen), unter derselben Sperre wie der
 * regulaere Postfach-Job. Liefert `locked`, wenn gerade ein Abruf laeuft.
 */
export async function runMailboxForOrg(
  orgId: string,
  now: Date = new Date(),
  client?: MailboxClient,
): Promise<{ locked: true } | { locked: false; messages: number; staged: number; error: string | null }> {
  let outcome: { messages: number; staged: number; error: string | null } = { messages: 0, staged: 0, error: null };
  const r = await withJobLock("mailbox", "MANUAL", now, async () => {
    // Wie der Scheduler nur bei eingeschaltetem Postfach (Einschalten setzt einen erfolgreichen Verbindungstest voraus).
    const settings = await dbInternal.inboundMailboxSettings.findUnique({ where: { orgId }, select: { enabled: true } });
    if (!settings || !settings.enabled) {
      outcome = { messages: 0, staged: 0, error: "DISABLED" };
      return { orgs: 0, messages: 0, staged: 0, errors: 1 };
    }
    const res = await fetchMailboxForOrg(orgId, now, client);
    outcome = { messages: res.messages, staged: res.staged, error: res.error };
    return { orgs: 1, messages: res.messages, staged: res.staged, errors: res.error === null ? 0 : 1 };
  });
  if (r.locked) return { locked: true };
  return { locked: false, ...outcome };
}
