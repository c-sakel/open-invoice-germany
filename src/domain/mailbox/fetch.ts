/**
 * Abruf des Rechnungs-Postfachs je Firma. Mails werden nur gelesen und als gelesen markiert, nie geloescht oder
 * verschoben. Anlagen (XML/PDF) landen in der Zwischenablage zur Sichtung; das Archiv bleibt unberuehrt, es gibt
 * weder Eingangsrechnung noch Aenderungsprotokoll-Eintrag. Server-Texte werden nie gespeichert, nur feste Codes.
 */
import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { berlinDateKey } from "@/lib/berlin-time";
import { decryptSecret, INBOUND_MAIL_PASSWORD_PURPOSE } from "@/lib/crypto/secrets";
import { createImapClient } from "@/lib/mailbox/imap-client";
import { MailboxError, type MailboxClient, type MailboxSession } from "@/lib/mailbox/client";
import { parseMailIsolated } from "@/lib/mailbox/parse-mail";
import { createNotification } from "@/domain/notifications/create";
import { loadNotificationSettings } from "@/domain/notifications/settings";
import { sanitizeFileName } from "@/domain/import/types";
import { detectContainer } from "@/domain/incoming/detect";
import { MAX_INCOMING_BYTES } from "@/domain/incoming/limits";
import { previewIncomingFile } from "@/domain/incoming/receive";
import { sha256Hex } from "@/lib/archive/storage";
import {
  INBOX_REMIND_DAYS,
  MAIL_RUN_TIMEOUT_MS,
  MAX_MAIL_BYTES,
  MAX_MAILS_PER_RUN,
  MAX_PARSE_ATTEMPTS,
  MAX_STAGED_PER_DOMAIN_PER_DAY,
  MAX_SUBJECT_CHARS,
} from "./limits";
import { stagingRelPath, writeStagingFile } from "./staging";
import { inboxUsage } from "./settings";

export interface FetchOrgResult {
  messages: number;
  staged: number;
  error: string | null;
}

interface AttachmentRow {
  partIndex: number;
  fileName: string;
  mime: string;
  size: number;
  sha256: string;
  stagingPath: string | null;
  status: "INBOX" | "DUPLICATE" | "SKIPPED";
  skipReason: string | null;
  previewJson: string | null;
  duplicateOfIncomingId: string | null;
  duplicateOfAttachmentId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_SHA = sha256Hex(Buffer.alloc(0));

/** Zeitueberschreitungen je Mail im Prozess (nach MAX_PARSE_ATTEMPTS wird sie als nicht lesbar vermerkt). */
const ATTEMPTS_KEY = Symbol.for("oig.mailboxFetch.attempts");
function attemptsMap(): Map<string, number> {
  const g = globalThis as { [ATTEMPTS_KEY]?: Map<string, number> };
  g[ATTEMPTS_KEY] ??= new Map<string, number>();
  return g[ATTEMPTS_KEY];
}
function countAttempt(key: string): number {
  const m = attemptsMap();
  if (m.size > 1000) m.clear();
  const n = (m.get(key) ?? 0) + 1;
  m.set(key, n);
  return n;
}

/**
 * Zurueckgestellte Mails (Tageslimit je Absender): je Firma eine eigene Teil-Map (Schluessel nur die orgId, nichts, was ein
 * Server variieren koennte), Position -> Ende des Fensters. Die Zahl der Teil-Maps ist durch die Zahl der eingerichteten
 * Postfaecher begrenzt, eine Gesamtobergrenze ist daher nicht noetig; leere oder abgelaufene Teil-Maps werden entfernt.
 */
const DEFERRED_KEY = Symbol.for("oig.mailboxFetch.deferred");
export const MAX_DEFERRED_PER_ACCOUNT = 2000;
/** Hoechstens so viele Mails je Lauf werden nur ueber ihre Kopfdaten (ohne Download) zurueckgestellt. */
const MAX_DEFER_SCANS_PER_RUN = 500;
type DeferredEntry = { until: number; domain: string };
function deferredStore(): Map<string, Map<string, DeferredEntry>> {
  const g = globalThis as { [DEFERRED_KEY]?: Map<string, Map<string, DeferredEntry>> };
  g[DEFERRED_KEY] ??= new Map();
  return g[DEFERRED_KEY];
}
export function getDeferred(account: string, key: string, nowMs: number = Date.now()): DeferredEntry | undefined {
  const store = deferredStore();
  const m = store.get(account);
  if (!m) return undefined;
  const e = m.get(key);
  if (e && e.until <= nowMs) {
    m.delete(key);
    if (m.size === 0) store.delete(account);
    return undefined;
  }
  return e;
}
/** Merkt eine Mail vor. Bei Ueberlauf verliert nur dieses Konto Eintraege: zuerst abgelaufene, dann die aeltesten. */
export function parkDeferred(account: string, key: string, entry: DeferredEntry, nowMs: number, max: number = MAX_DEFERRED_PER_ACCOUNT): void {
  const store = deferredStore();
  let m = store.get(account);
  if (!m) {
    m = new Map();
    store.set(account, m);
  }
  for (const [k, v] of m) if (v.until <= nowMs) m.delete(k);
  m.delete(key); // erneutes Vormerken zaehlt als juengster Eintrag
  if (m.size >= max) {
    for (const [k, v] of m) if (v.until <= nowMs) m.delete(k);
    for (const k of m.keys()) {
      if (m.size < max) break;
      m.delete(k);
    }
  }
  m.set(key, entry);
}

export function senderAllowed(senderDomain: string | null, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (senderDomain === null) return false;
  return allowed.some((d) => senderDomain === d || senderDomain.endsWith(`.${d}`));
}

function parseDomains(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function mailboxAccountKey(host: string, port: number, username: string, folder: string): string {
  return createHash("sha256").update(`${host}|${port}|${username}|${folder}`).digest("hex").slice(0, 32);
}

async function notify(orgId: string, now: Date, type: "INBOUND_MAIL_NEW" | "INBOUND_MAIL_ERROR", title: string, keySuffix: string): Promise<void> {
  try {
    const s = await loadNotificationSettings(orgId);
    if (!s.enabledTypes.includes(type)) return;
    await createNotification({ orgId, type, title, link: "/eingang?quelle=postfach", entityType: "INBOUND_MAIL", dedupeKey: `${type}:${orgId}:${keySuffix}`, at: now });
  } catch (e) {
    console.error("Postfach: Meldung nicht angelegt", e instanceof Error ? e.name : "unbekannt");
  }
}

const ERROR_TITLES: Record<string, string> = {
  QUOTA_FULL: "Postfach-Abruf pausiert: Die Sichtung ist voll. Bitte Belege uebernehmen oder verwerfen.",
  SECRET_UNREADABLE: "Postfach-Abruf nicht moeglich: Das gespeicherte Passwort ist nicht lesbar. Bitte neu eingeben.",
  AUTH_FAILED: "Postfach-Abruf: Die Anmeldung wurde abgelehnt.",
  OAUTH_REQUIRED: "Dieses Postfach erlaubt keine Anmeldung mit Passwort. Bitte ein App-Passwort oder ein eigenes Postfach fuer Rechnungen verwenden.",
};
function errorTitle(code: string): string {
  return ERROR_TITLES[code] ?? `Postfach-Abruf gestoert (${code}).`;
}

async function saveRun(orgId: string, now: Date, error: string | null, fetched: number): Promise<void> {
  await dbInternal.inboundMailboxSettings.update({
    where: { orgId },
    data: { lastRunAt: now, lastRunOk: error === null, lastRunError: error, lastRunFetched: fetched },
    select: { id: true },
  });
}

async function finish(orgId: string, now: Date, error: string | null, messages: number, staged: number): Promise<FetchOrgResult> {
  await saveRun(orgId, now, error, messages);
  const day = berlinDateKey(now);
  if (error !== null) await notify(orgId, now, "INBOUND_MAIL_ERROR", errorTitle(error), `${error}:${day}`);
  if (staged > 0) await notify(orgId, now, "INBOUND_MAIL_NEW", `${staged} neue Beleg-Anlage(n) im Postfach zur Sichtung`, day);
  const old = await dbInternal.inboundMailAttachment.count({ where: { orgId, status: "INBOX", createdAt: { lt: new Date(now.getTime() - INBOX_REMIND_DAYS * DAY_MS) } } });
  if (old > 0) await notify(orgId, now, "INBOUND_MAIL_NEW", `${old} Anlage(n) warten seit ueber ${INBOX_REMIND_DAYS} Tagen auf Entscheidung`, `REMIND:${day}`);
  return { messages, staged, error };
}

function safeName(name: string, index: number): string {
  return sanitizeFileName(name) ?? `anlage-${index + 1}`;
}

export async function fetchMailboxForOrg(
  orgId: string,
  now: Date,
  client: MailboxClient = createImapClient(),
  opts: { runTimeoutMs?: number } = {},
): Promise<FetchOrgResult> {
  const row = await dbInternal.inboundMailboxSettings.findUnique({
    where: { orgId },
    select: { host: true, port: true, security: true, username: true, passwordEnc: true, folder: true, fetchSince: true, allowedSenderDomainsJson: true },
  });
  if (!row || !row.host || !row.username || !row.passwordEnc) return { messages: 0, staged: 0, error: "NOT_CONFIGURED" };
  const { host, username } = row;

  const usage = await inboxUsage(orgId);
  if (usage.quotaReached) return finish(orgId, now, "QUOTA_FULL", 0, 0);

  let password: string;
  try {
    password = decryptSecret(row.passwordEnc, INBOUND_MAIL_PASSWORD_PURPOSE);
  } catch {
    return finish(orgId, now, "SECRET_UNREADABLE", 0, 0);
  }
  const port: 993 | 143 = row.port === 143 ? 143 : 993;
  const security = row.security === "STARTTLS" ? "STARTTLS" : "TLS";
  const accountKey = mailboxAccountKey(host, port, username, row.folder);
  const allowed = parseDomains(row.allowedSenderDomainsJson);

  let session: MailboxSession | null = null;
  let uidValidity = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const s = session;
    if (s) void s.close().catch(() => undefined);
  }, opts.runTimeoutMs ?? MAIL_RUN_TIMEOUT_MS);
  const open = async (): Promise<MailboxSession> => {
    const s = await client.open({ host, port, security, username, password, folder: row.folder });
    if (uidValidity !== "" && s.uidValidity !== uidValidity) {
      await s.close().catch(() => undefined);
      throw new MailboxError("PROTOCOL_ERROR");
    }
    uidValidity = s.uidValidity;
    session = s;
    return s;
  };
  /** Jede Sitzung wird nach einem Fehler vom Adapter geschlossen; die naechste Operation oeffnet neu. */
  const op = async <T>(fn: (s: MailboxSession) => Promise<T>): Promise<T> => {
    if (timedOut) throw new MailboxError("TIMEOUT");
    const s = session ?? (await open());
    try {
      return await fn(s);
    } catch (e) {
      session = null;
      throw e;
    }
  };

  let messages = 0;
  let staged = 0;
  let retries = 0;
  let error: string | null = null;
  /** Absenderdomains, deren Tageslimit erreicht ist; ihre Mails bleiben ungelesen und werden spaeter erneut versucht. */
  const limitedDomains = new Set<string>();
  let downloads = 0;
  const deferKey = (uid: string): string => `${orgId}:${accountKey}:${uidValidity}:${uid}`;
  /** Merkt die Mail bis zum Fensterende des Absender-Tageslimits vor; liefert true, wenn das Limit erreicht ist. */
  const deferIfLimited = async (uid: string, domain: string): Promise<boolean> => {
    const since = new Date(now.getTime() - DAY_MS);
    const times = await dbInternal.inboundMailMessage.findMany({
      where: { orgId, senderDomain: domain, result: "STAGED", fetchedAt: { gt: since } },
      orderBy: { fetchedAt: "asc" },
      select: { fetchedAt: true },
    });
    if (times.length < MAX_STAGED_PER_DOMAIN_PER_DAY) return false;
    // Das Limit unterschreitet der Zaehler, sobald die aelteste noetige Zeile aus dem 24-Stunden-Fenster faellt.
    const freeing = times[times.length - MAX_STAGED_PER_DOMAIN_PER_DAY];
    parkDeferred(orgId, deferKey(uid), { until: (freeing?.fetchedAt.getTime() ?? now.getTime()) + DAY_MS, domain }, now.getTime());
    limitedDomains.add(domain);
    return true;
  };
  try {
    const uids = await op((s) => s.searchUnseen(row.fetchSince));
    const known = new Set(
      (
        await dbInternal.inboundMailMessage.findMany({
          where: { orgId, accountKey, uidValidity, uid: { in: uids } },
          select: { uid: true },
        })
      ).map((m) => m.uid),
    );
    for (const uid of uids.filter((u) => known.has(u))) {
      // Nach einem Absturz zwischen Speichern und Markieren: nur noch markieren.
      await op((s) => s.markSeen(uid)).catch(() => undefined);
    }
    const fresh = uids.filter((u) => !known.has(u));
    // Zurueckgestellte Mails (Tageslimit) zaehlen nicht gegen die Grenze je Lauf, damit sie andere Absender nicht
    // verdraengen; die Zahl der geprueften Mails bleibt trotzdem begrenzt.
    let handled = 0;
    let deferScans = 0;
    for (const uid of fresh) {
      if (handled >= MAX_MAILS_PER_RUN || downloads >= MAX_MAILS_PER_RUN * 3 || deferScans >= MAX_DEFER_SCANS_PER_RUN) break;
      // Bereits zurueckgestellt und das Fenster laeuft noch: weder Abruf noch Anrechnung auf die Grenzen.
      const parked = getDeferred(orgId, deferKey(uid), now.getTime());
      if (parked && parked.until > now.getTime()) {
        limitedDomains.add(parked.domain);
        continue;
      }
      if (timedOut) throw new MailboxError("TIMEOUT");
      // Kontingent je Mail pruefen: ein Lauf darf die Sichtung nicht ueber die Grenze fuellen.
      if ((await inboxUsage(orgId)).quotaReached) {
        error = "QUOTA_FULL";
        break;
      }
      let r: number | null;
      try {
        r = await processUid(uid);
      } catch (e) {
        if (e instanceof ParseRetry) {
          retries += 1;
          continue;
        }
        // Dauerhafter Protokollfehler an genau dieser Mail (z. B. defekte Nachricht): nach mehreren Versuchen
        // vermerken und als gelesen markieren, sonst blockiert sie jeden Folgelauf.
        const poison =
          e instanceof MailboxError && e.code === "PROTOCOL_ERROR" && !timedOut && uidValidity !== "" && countAttempt(`fetch:${orgId}:${accountKey}:${uidValidity}:${uid}`) >= MAX_PARSE_ATTEMPTS;
        if (!poison) throw e;
        r = await commit(uid, { orgId, accountKey, uidValidity, uid, internalDate: null, fetchedAt: now, size: 0, result: "FETCH_FAILED", messageIdHash: null, senderDomain: null, subject: null }, []);
      }
      if (r === null) {
        if (getDeferred(orgId, deferKey(uid), now.getTime()) !== undefined) deferScans += 1;
        continue;
      }
      handled += 1;
      messages += 1;
      staged += r;
    }
    if (retries > 0) error = "TIMEOUT";
  } catch (e) {
    error = timedOut ? "TIMEOUT" : e instanceof MailboxError ? e.code : "PROTOCOL_ERROR";
  } finally {
    clearTimeout(timer);
    const s = session as MailboxSession | null;
    if (s) await s.close().catch(() => undefined);
  }
  const day = berlinDateKey(now);
  for (const domain of limitedDomains) {
    await notify(orgId, now, "INBOUND_MAIL_ERROR", `Postfach: Das Tageslimit fuer den Absender ${domain} ist erreicht. Weitere Mails bleiben ungelesen und werden spaeter erneut versucht.`, `SENDER_LIMIT:${domain}:${day}`);
  }
  return finish(orgId, now, error, messages, staged);

  /** Liefert die Zahl neuer Anlagen in der Sichtung, oder null, wenn die Mail uebersprungen oder zurueckgestellt wurde. */
  async function processUid(uid: string): Promise<number | null> {
    const meta = await op((s) => s.meta(uid));
    if (meta === null) return null;
    // Vorabpruefung ueber den Envelope (ohne Download): Mails eines Absenders ueber dem Tageslimit gar nicht erst laden.
    if (meta.fromDomain && (await deferIfLimited(uid, meta.fromDomain))) return null;
    const base = { orgId, accountKey, uidValidity, uid, internalDate: meta.internalDate, fetchedAt: now, size: meta.size };
    let raw: Uint8Array | null = null;
    let tooLarge = meta.size > MAX_MAIL_BYTES;
    if (!tooLarge) {
      try {
        downloads += 1;
        raw = await op((s) => s.fetchRaw(uid, MAX_MAIL_BYTES));
      } catch (e) {
        if (e instanceof MailboxError && e.code === "TOO_LARGE") tooLarge = true;
        else throw e;
      }
    }
    if (tooLarge || raw === null) return commit(uid, { ...base, result: "TOO_LARGE", messageIdHash: null, senderDomain: null, subject: null }, []);

    const parsed = await parseMailIsolated(raw);
    if (!parsed.ok) {
      if (parsed.code === "TIMEOUT" || parsed.code === "OUT_OF_MEMORY") {
        if (countAttempt(`${orgId}:${accountKey}:${uidValidity}:${uid}`) < MAX_PARSE_ATTEMPTS) throw new ParseRetry();
      }
      return commit(uid, { ...base, result: "PARSE_FAILED", messageIdHash: null, senderDomain: null, subject: null }, []);
    }
    const mail = parsed.mail;
    const head = {
      ...base,
      messageIdHash: mail.messageIdHash,
      senderDomain: mail.senderDomain,
      subject: mail.subject ? mail.subject.slice(0, MAX_SUBJECT_CHARS) : null,
    };
    // Die Message-Id stammt vom Absender und dient nur als Hinweis im Protokoll, nie zum Verwerfen:
    // Doppelte Abrufe erkennt die Position (Konto, UIDVALIDITY, UID), doppelte Belege der Datei-Hash.
    if (!senderAllowed(mail.senderDomain, allowed)) return commit(uid, { ...head, result: "SENDER_NOT_ALLOWED" }, []);
    if (mail.senderDomain !== null && (await deferIfLimited(uid, mail.senderDomain))) {
      // Weder protokollieren noch als gelesen markieren: die Mail wird nach Ablauf des Fensters erneut versucht.
      return null;
    }

    const rows: AttachmentRow[] = [];
    const seenHashes = new Map<string, number>();
    for (const sk of mail.skipped) {
      rows.push({ partIndex: sk.index, fileName: `anlage-${sk.index + 1}`, mime: "", size: 0, sha256: EMPTY_SHA, stagingPath: null, status: "SKIPPED", skipReason: sk.reason, previewJson: null, duplicateOfIncomingId: null, duplicateOfAttachmentId: null });
    }
    for (const att of mail.attachments) {
      const fileName = safeName(att.fileName, att.index);
      const buf = Buffer.from(att.bytes.buffer, att.bytes.byteOffset, att.bytes.byteLength);
      const sha256 = sha256Hex(buf);
      const skip = (reason: string): AttachmentRow => ({ partIndex: att.index, fileName, mime: att.declaredType.slice(0, 255), size: buf.length, sha256, stagingPath: null, status: "SKIPPED", skipReason: reason, previewJson: null, duplicateOfIncomingId: null, duplicateOfAttachmentId: null });
      let ext: "xml" | "pdf";
      try {
        if (buf.length > MAX_INCOMING_BYTES) {
          rows.push(skip("TOO_LARGE"));
          continue;
        }
        const c = detectContainer(buf);
        if (c.type === "IMAGE") {
          rows.push(skip("TYPE"));
          continue;
        }
        ext = c.type === "XML" ? "xml" : "pdf";
      } catch {
        rows.push(skip("TYPE"));
        continue;
      }
      const mime = ext === "xml" ? "application/xml" : "application/pdf";
      const common = { partIndex: att.index, fileName, mime, size: buf.length, sha256, skipReason: null, stagingPath: null, previewJson: null };
      const incoming = await dbInternal.incomingInvoice.findUnique({ where: { orgId_originalSha256: { orgId, originalSha256: sha256 } }, select: { id: true } });
      if (incoming) {
        rows.push({ ...common, status: "DUPLICATE", duplicateOfIncomingId: incoming.id, duplicateOfAttachmentId: null });
        continue;
      }
      const sameMail = seenHashes.get(sha256);
      const other = await dbInternal.inboundMailAttachment.findFirst({
        // Verworfene Anlagen ohne Kopie (aufgeraeumt) zaehlen nicht mehr: ein spaeter erneut gesendetes Dokument kommt wieder in die Sichtung.
        where: { orgId, sha256, status: { in: ["INBOX", "DISCARDED"] }, stagingPath: { not: null } },
        select: { id: true },
      });
      if (other || sameMail !== undefined) {
        rows.push({ ...common, status: "DUPLICATE", duplicateOfIncomingId: null, duplicateOfAttachmentId: other?.id ?? null });
        continue;
      }
      seenHashes.set(sha256, att.index);
      const rel = stagingRelPath(orgId, sha256, ext);
      await writeStagingFile(rel, buf);
      let previewJson: string | null = null;
      try {
        previewJson = JSON.stringify(await previewIncomingFile(buf));
      } catch {
        previewJson = null;
      }
      rows.push({ ...common, status: "INBOX", stagingPath: rel, previewJson, duplicateOfIncomingId: null, duplicateOfAttachmentId: null });
    }
    rows.sort((a, b) => a.partIndex - b.partIndex);
    const inbox = rows.filter((r) => r.status === "INBOX").length;
    // Dublette nur, wenn jede Anlage der Mail bereits bekannt ist; Anlagen werden immer einzeln geprueft.
    const allDuplicates = rows.length > 0 && rows.every((r) => r.status === "DUPLICATE");
    return commit(uid, { ...head, result: inbox > 0 ? "STAGED" : allDuplicates ? "DUPLICATE_MESSAGE" : "NO_ATTACHMENT" }, rows);
  }

  async function commit(
    uid: string,
    head: { orgId: string; accountKey: string; uidValidity: string; uid: string; internalDate: Date | null; fetchedAt: Date; size: number; result: string; messageIdHash: string | null; senderDomain: string | null; subject: string | null },
    rows: AttachmentRow[],
  ): Promise<number | null> {
    let created = true;
    try {
      await dbInternal.$transaction(async (tx) => {
        const msg = await tx.inboundMailMessage.create({ data: head, select: { id: true } });
        for (const r of rows) {
          await tx.inboundMailAttachment.create({ data: { orgId, messageId: msg.id, ...r }, select: { id: true } });
        }
      });
    } catch (e) {
      // Schon verarbeitet (paralleler Lauf): nur noch markieren.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      created = false;
    }
    // Fehler beim Markieren sind unkritisch: der naechste Lauf erkennt die Mail an der Protokollzeile.
    await op((s) => s.markSeen(uid)).catch(() => undefined);
    return created ? rows.filter((r) => r.status === "INBOX").length : null;
  }
}

/** Interne Unterbrechung: die Mail bleibt ungelesen und wird im naechsten Lauf erneut versucht. */
class ParseRetry extends Error {
  constructor() {
    super("PARSE_RETRY");
  }
}
