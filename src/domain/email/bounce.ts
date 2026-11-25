/**
 * Zustellberichte (RFC 3464) dem Versandprotokoll zuordnen. Der Bericht kommt aus dem Postfach-Abruf
 * (domain/mailbox/fetch.ts), geparst im isolierten Worker; hier kommen nur Aktion, Status und der Hash
 * der Message-Id der Originalmail an.
 *
 * Streng: nur `Action: failed` mit Status 5.x.x wirkt. Zugeordnet wird ausschliesslich ueber den Hash der
 * Message-Id (EmailLog.providerId) innerhalb derselben Organisation und der letzten 30 Tage; Absender,
 * Adressen oder Texte des Berichts spielen keine Rolle (eine Faelschung ohne bekannte zufaellige
 * Message-Id ordnet nichts zu).
 */
import { dbInternal } from "@/lib/db";
import { messageIdHash } from "@/lib/mailbox/message-id";
import type { ParsedDsn } from "@/lib/mailbox/parse-mail";
import { markAutoSendBounced } from "@/domain/recurring/auto-send";
import { markEmailBounced } from "./email-log";

export type BounceResult = "MATCHED" | "UNMATCHED" | "IGNORED";

export const BOUNCE_WINDOW_DAYS = 30;
const MAX_CANDIDATES = 5000;
export const BOUNCE_ACTOR = "mailbox";

export async function applyBounce(orgId: string, dsn: ParsedDsn, now: Date): Promise<BounceResult> {
  if (dsn.action !== "failed" || dsn.status === null || !dsn.status.startsWith("5.")) return "IGNORED";
  if (dsn.originalMessageIdHash === null) return "UNMATCHED";
  const since = new Date(now.getTime() - BOUNCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await dbInternal.emailLog.findMany({
    where: { orgId, status: "SENT", providerId: { not: null }, sentAt: { gte: since } },
    orderBy: { sentAt: "desc" },
    take: MAX_CANDIDATES,
    select: { id: true, providerId: true },
  });
  const hit = candidates.find((c) => messageIdHash(c.providerId) === dsn.originalMessageIdHash);
  if (!hit) return "UNMATCHED";
  await markEmailBounced(orgId, hit.id, BOUNCE_ACTOR, now);
  await markAutoSendBounced(orgId, hit.id, now);
  return "MATCHED";
}
