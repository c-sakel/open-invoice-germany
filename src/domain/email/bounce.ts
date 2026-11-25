/**
 * Zustellberichte (RFC 3464) dem Versandprotokoll zuordnen. Der Bericht kommt aus dem Postfach-Abruf
 * (domain/mailbox/fetch.ts), geparst im isolierten Worker; hier kommen nur Aktion, Status und der Hash
 * der Message-Id der Originalmail an.
 *
 * Streng: nur `Action: failed` mit Status 5.x.x wirkt. Zugeordnet wird ausschliesslich ueber den Hash der
 * Message-Id (EmailLog.providerId) innerhalb derselben Organisation und der letzten 30 Tage; Absender,
 * Adressen oder Texte des Berichts spielen keine Rolle (eine Faelschung ohne bekannte zufaellige
 * Message-Id ordnet nichts zu). Zusaetzlich muss mindestens eine Domain der Final-Recipient-Felder zu den
 * Empfaengern (An/Cc/Bcc) des Protokolls passen; fehlt sie, ordnet der Bericht nichts zu. Die Message-Id ist
 * dem Empfaenger bekannt, ein Bericht ist also nicht authentifiziert: BOUNCED aendert keine Belege und gilt
 * nie als Nachweis der Nichtzustellung.
 *
 * Wiederholbar: auch BOUNCED-Protokolle sind Kandidaten, Protokoll, Auto-Versand-Zeile und Benachrichtigung
 * werden je einzeln und idempotent nachgezogen (Abbruch zwischen den Schritten geht nicht verloren).
 * Die Suche betrachtet die 5000 juengsten Versendungen der letzten 30 Tage je Organisation; aeltere
 * Rueckblaeufer bei mehr Versand bleiben UNMATCHED (siehe LIMITATIONEN).
 */
import { dbInternal } from "@/lib/db";
import { messageIdHash } from "@/lib/mailbox/message-id";
import type { ParsedDsn } from "@/lib/mailbox/parse-mail";
import { markAutoSendBounced } from "@/domain/recurring/auto-send";
import { onEmailBounced } from "@/domain/notifications/hooks";
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
    where: { orgId, status: { in: ["SENT", "BOUNCED"] }, providerId: { not: null }, sentAt: { gte: since } },
    orderBy: { sentAt: "desc" },
    take: MAX_CANDIDATES,
    select: { id: true, providerId: true, docType: true, docId: true, toJson: true, ccJson: true, bccJson: true },
  });
  const hit = candidates.find((c) => messageIdHash(c.providerId) === dsn.originalMessageIdHash);
  if (!hit) return "UNMATCHED";
  const logDomains = new Set([...domainsOf(hit.toJson), ...domainsOf(hit.ccJson), ...domainsOf(hit.bccJson)]);
  if (!dsn.finalRecipientDomains.some((d) => logDomains.has(d))) return "UNMATCHED";
  const logChanged = await markEmailBounced(orgId, hit.id, BOUNCE_ACTOR, now);
  const outboxChanged = await markAutoSendBounced(orgId, hit.id, now);
  // Meldung nachholen, falls ein frueherer Lauf nach dem Statuswechsel abbrach (dedupeKey macht sie idempotent).
  const first = parseAddresses(hit.toJson)[0];
  await onEmailBounced(orgId, { logId: hit.id, docType: hit.docType, docId: hit.docId, to: first || undefined });
  return logChanged || outboxChanged ? "MATCHED" : "UNMATCHED";
}

function parseAddresses(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function domainsOf(json: string): string[] {
  return parseAddresses(json)
    .map((a) => a.slice(a.lastIndexOf("@") + 1).trim().toLowerCase().replace(/>$/, "").replace(/\.$/, ""))
    .filter((d) => d !== "");
}
