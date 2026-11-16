/**
 * Einstellungen des Rechnungs-Postfachs je Firma. Das Passwort wird nur verschluesselt gespeichert und nie
 * ausgegeben; Fehler des Servers werden nur als fester Code gespeichert.
 */
import { dbInternal } from "@/lib/db";
import { berlinCalendarDay } from "@/lib/berlin-time";
import { decryptSecret, encryptSecret, INBOUND_MAIL_PASSWORD_PURPOSE } from "@/lib/crypto/secrets";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { logActivity } from "@/domain/activity/log";
import { createImapClient } from "@/lib/mailbox/imap-client";
import { MailboxError, type MailboxClient } from "@/lib/mailbox/client";
import { mailboxSettingsInputSchema } from "@/schemas/mailbox";
import { MailboxSettingsError } from "./errors";
import { MAILBOX_TEST_COOLDOWN_MS, MAX_FETCH_SINCE_DAYS, MAX_INBOX_ATTACHMENTS, MAX_INBOX_BYTES } from "./limits";

export interface MailboxSettingsView {
  enabled: boolean;
  host: string | null;
  port: number;
  security: "TLS" | "STARTTLS";
  username: string | null;
  hasPassword: boolean;
  folder: string;
  fetchSince: string | null;
  allowedSenderDomains: string[];
  canEnable: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastRunAt: Date | null;
  lastRunOk: boolean | null;
  lastRunError: string | null;
  lastRunFetched: number;
  inbox: { count: number; bytes: number; quotaReached: boolean };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const SELECT = {
  id: true,
  enabled: true,
  host: true,
  port: true,
  security: true,
  username: true,
  passwordEnc: true,
  folder: true,
  fetchSince: true,
  allowedSenderDomainsJson: true,
  credentialsChangedAt: true,
  lastTestAt: true,
  lastTestOk: true,
  lastTestError: true,
  lastRunAt: true,
  lastRunOk: true,
  lastRunError: true,
  lastRunFetched: true,
} as const;

export function maskUsername(user: string): string {
  const at = user.indexOf("@");
  const first = user.slice(0, 1);
  return at > 0 ? `${first}***${user.slice(at)}` : `${first}***`;
}

function parseDomains(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function inboxUsage(orgId: string): Promise<{ count: number; bytes: number; quotaReached: boolean }> {
  const agg = await dbInternal.inboundMailAttachment.aggregate({
    where: { orgId, status: "INBOX" },
    _count: { _all: true },
    _sum: { size: true },
  });
  const count = agg._count._all;
  const bytes = agg._sum.size ?? 0;
  return { count, bytes, quotaReached: count >= MAX_INBOX_ATTACHMENTS || bytes >= MAX_INBOX_BYTES };
}

export async function loadMailboxSettings(orgId: string, opts: { maskUser?: boolean } = {}): Promise<MailboxSettingsView> {
  const row = await dbInternal.inboundMailboxSettings.findUnique({ where: { orgId }, select: SELECT });
  const inbox = await inboxUsage(orgId);
  const hasPassword = row?.passwordEnc != null;
  const testFresh =
    row != null &&
    row.lastTestOk === true &&
    row.lastTestAt != null &&
    (row.credentialsChangedAt == null || row.lastTestAt.getTime() >= row.credentialsChangedAt.getTime());
  return {
    enabled: row?.enabled ?? false,
    host: row?.host ?? null,
    port: row?.port ?? 993,
    security: row?.security === "STARTTLS" ? "STARTTLS" : "TLS",
    username: row?.username == null ? null : opts.maskUser ? maskUsername(row.username) : row.username,
    hasPassword,
    folder: row?.folder ?? "INBOX",
    fetchSince: row?.fetchSince ? row.fetchSince.toISOString().slice(0, 10) : null,
    allowedSenderDomains: row ? parseDomains(row.allowedSenderDomainsJson) : [],
    canEnable: Boolean(row?.host && row.username && hasPassword && testFresh),
    lastTestAt: row?.lastTestAt ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastTestError: row?.lastTestError ?? null,
    lastRunAt: row?.lastRunAt ?? null,
    lastRunOk: row?.lastRunOk ?? null,
    lastRunError: row?.lastRunError ?? null,
    lastRunFetched: row?.lastRunFetched ?? 0,
    inbox,
  };
}

export async function saveMailboxSettings(orgId: string, raw: unknown, actor: string, now: Date = new Date()): Promise<MailboxSettingsView> {
  const input = mailboxSettingsInputSchema.parse(raw);
  let fetchSince: Date | null | undefined;
  if (input.fetchSince !== undefined) {
    if (input.fetchSince === null) fetchSince = null;
    else {
      fetchSince = new Date(`${input.fetchSince}T00:00:00.000Z`);
      const today = berlinCalendarDay(now).getTime();
      if (fetchSince.getTime() > today || fetchSince.getTime() < today - MAX_FETCH_SINCE_DAYS * DAY_MS) {
        throw new MailboxSettingsError("FETCH_SINCE_INVALID");
      }
    }
  }
  // Wirft SecretsUnavailableError ohne AUTH_SECRET, bevor etwas gespeichert wird.
  const newPasswordEnc = typeof input.password === "string" ? encryptSecret(input.password, INBOUND_MAIL_PASSWORD_PURPOSE) : undefined;

  const existing = await dbInternal.inboundMailboxSettings.findUnique({ where: { orgId }, select: SELECT });
  // Das gespeicherte Passwort darf nie an einen anderen Server oder fuer einen anderen Benutzer gehen:
  // ohne neues Passwort wird es bei Aenderung von Server, Port, Sicherheit oder Benutzer entfernt.
  const targetChanged =
    existing != null && (existing.host !== input.host || existing.port !== input.port || existing.security !== input.security || existing.username !== input.username);
  const dropPassword = targetChanged && newPasswordEnc === undefined && existing?.passwordEnc != null;
  const passwordEnc = newPasswordEnc;
  const changed: string[] = [];
  if (existing?.host !== input.host) changed.push("host");
  if ((existing?.port ?? 993) !== input.port) changed.push("port");
  if ((existing?.security ?? "TLS") !== input.security) changed.push("security");
  if (existing?.username !== input.username) changed.push("username");
  if ((existing?.folder ?? "INBOX") !== input.folder) changed.push("folder");
  if (passwordEnc !== undefined) changed.push("password");
  if ((input.password === null || dropPassword) && existing?.passwordEnc != null) changed.push("password");
  const credentialsChanged = changed.some((k) => ["host", "port", "security", "username", "folder", "password"].includes(k));
  const domainsJson = input.allowedSenderDomains === undefined ? undefined : JSON.stringify(input.allowedSenderDomains);
  if (domainsJson !== undefined && existing && existing.allowedSenderDomainsJson !== domainsJson) changed.push("allowedSenderDomains");
  if (!existing && input.allowedSenderDomains !== undefined && input.allowedSenderDomains.length > 0) changed.push("allowedSenderDomains");
  if (fetchSince !== undefined && (existing?.fetchSince?.getTime() ?? null) !== (fetchSince?.getTime() ?? null)) changed.push("fetchSince");

  const data = {
    host: input.host,
    port: input.port,
    security: input.security,
    username: input.username,
    folder: input.folder,
    ...(domainsJson !== undefined ? { allowedSenderDomainsJson: domainsJson } : {}),
    ...(passwordEnc !== undefined ? { passwordEnc } : input.password === null || dropPassword ? { passwordEnc: null } : {}),
    ...(fetchSince !== undefined ? { fetchSince } : {}),
    ...(credentialsChanged ? { enabled: false, lastTestOk: null, credentialsChangedAt: now } : {}),
  };
  const row = await dbInternal.inboundMailboxSettings.upsert({
    where: { orgId },
    create: { orgId, ...data },
    update: data,
    select: { id: true },
  });
  if (changed.length > 0) {
    await logActivity(dbInternal, { orgId, entityType: "INBOUND_MAIL", entityId: row.id, type: "UPDATED", actor, at: now, data: { changed: [...new Set(changed)] } });
  }
  return loadMailboxSettings(orgId);
}

export type MailboxTestResult = { ok: true; unseen: number } | { ok: false; code: string };

export async function testMailboxConnection(orgId: string, actor: string, client: MailboxClient = createImapClient(), now: Date = new Date()): Promise<MailboxTestResult> {
  const row = await dbInternal.inboundMailboxSettings.findUnique({ where: { orgId }, select: SELECT });
  if (!row || !row.host || !row.username || !row.passwordEnc) return { ok: false, code: "NOT_CONFIGURED" };
  try {
    rateLimit(`mailbox-test:${orgId}`, { limit: 1, windowMs: MAILBOX_TEST_COOLDOWN_MS });
  } catch (e) {
    if (e instanceof RateLimitError) return { ok: false, code: "COOLDOWN" };
    throw e;
  }
  let result: MailboxTestResult = { ok: false, code: "SECRET_UNREADABLE" };
  let password: string | null = null;
  try {
    password = decryptSecret(row.passwordEnc, INBOUND_MAIL_PASSWORD_PURPOSE);
  } catch {
    password = null;
  }
  if (password !== null) {
    try {
      const session = await client.open({
        host: row.host,
        port: row.port === 143 ? 143 : 993,
        security: row.security === "STARTTLS" ? "STARTTLS" : "TLS",
        username: row.username,
        password,
        folder: row.folder,
      });
      try {
        result = { ok: true, unseen: await session.countUnseen() };
      } finally {
        await session.close().catch(() => undefined);
      }
    } catch (e) {
      result = { ok: false, code: e instanceof MailboxError ? e.code : "PROTOCOL_ERROR" };
    }
  }
  await dbInternal.inboundMailboxSettings.update({
    where: { orgId },
    data: { lastTestAt: now, lastTestOk: result.ok, lastTestError: result.ok ? null : result.code },
    select: { id: true },
  });
  await logActivity(dbInternal, { orgId, entityType: "INBOUND_MAIL", entityId: row.id, type: "STATUS_CHANGED", actor, at: now, data: { test: result.ok ? "OK" : result.code } });
  return result;
}

export async function setMailboxEnabled(orgId: string, enabled: boolean, actor: string, now: Date = new Date()): Promise<MailboxSettingsView> {
  const row = await dbInternal.inboundMailboxSettings.findUnique({ where: { orgId }, select: SELECT });
  if (!row) {
    if (!enabled) return loadMailboxSettings(orgId);
    throw new MailboxSettingsError("NOT_CONFIGURED");
  }
  if (enabled) {
    if (!row.host || !row.username || !row.passwordEnc) throw new MailboxSettingsError("NOT_CONFIGURED");
    const fresh =
      row.lastTestOk === true &&
      row.lastTestAt != null &&
      (row.credentialsChangedAt == null || row.lastTestAt.getTime() >= row.credentialsChangedAt.getTime());
    if (!fresh) throw new MailboxSettingsError("TEST_REQUIRED");
  }
  await dbInternal.inboundMailboxSettings.update({
    where: { orgId },
    data: { enabled, ...(enabled && row.fetchSince == null ? { fetchSince: berlinCalendarDay(now) } : {}) },
    select: { id: true },
  });
  await logActivity(dbInternal, { orgId, entityType: "INBOUND_MAIL", entityId: row.id, type: "STATUS_CHANGED", actor, at: now, data: { enabled } });
  return loadMailboxSettings(orgId);
}
