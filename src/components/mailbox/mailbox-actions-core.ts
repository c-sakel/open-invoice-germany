/**
 * Kern der Server-Actions für Postfach-Einstellungen und Sichtung: gleiche Domainfunktionen und Schemas wie REST
 * und MCP, aber mit festen Texten für die Oberfläche. Die Organisation kommt vom Aufrufer (Sitzung); fremde und
 * unbekannte Ids liefern denselben Text. Das Passwort verlässt diese Schicht nie, Servertexte werden nie weitergegeben.
 */
import { ZodError } from "zod";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { describeError } from "@/lib/safe-error";
import type { MailboxClient } from "@/lib/mailbox/client";
import { NotFoundError } from "@/domain/errors";
import { IncomingBusyError, IncomingFormatError } from "@/domain/incoming/errors";
import { runMailboxForOrg } from "@/domain/mailbox/job";
import { loadMailboxSettings, saveMailboxSettings, setMailboxEnabled, testMailboxConnection, type MailboxSettingsView } from "@/domain/mailbox/settings";
import { MailboxSettingsError, InboundMailError } from "@/domain/mailbox/errors";
import { acceptInboundAttachment, acceptInboundAttachments, discardInboundAttachment, restoreInboundAttachment, type AcceptBatchEntry } from "@/domain/mailbox/decide";
import { mailboxErrorText, GENERIC_MAILBOX_ERROR } from "./mailbox-ui";

export interface MailboxSettingsClientView {
  enabled: boolean;
  host: string;
  port: 993 | 143;
  security: "TLS" | "STARTTLS";
  username: string;
  hasPassword: boolean;
  folder: string;
  fetchSince: string;
  allowedSenderDomains: string[];
  canEnable: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunError: string | null;
  lastRunFetched: number;
  inbox: { count: number; bytes: number; quotaReached: boolean };
}

/** Serialisierbare Sicht für die Oberfläche; enthält nie ein Passwort, nur "hinterlegt" ja/nein. */
export function toMailboxClientView(v: MailboxSettingsView): MailboxSettingsClientView {
  return {
    enabled: v.enabled,
    host: v.host ?? "",
    port: v.port === 143 ? 143 : 993,
    security: v.security,
    username: v.username ?? "",
    hasPassword: v.hasPassword,
    folder: v.folder,
    fetchSince: v.fetchSince ?? "",
    allowedSenderDomains: v.allowedSenderDomains,
    canEnable: v.canEnable,
    lastTestAt: v.lastTestAt?.toISOString() ?? null,
    lastTestOk: v.lastTestOk,
    lastTestError: v.lastTestError,
    lastRunAt: v.lastRunAt?.toISOString() ?? null,
    lastRunOk: v.lastRunOk,
    lastRunError: v.lastRunError,
    lastRunFetched: v.lastRunFetched,
    inbox: v.inbox,
  };
}

export type UiResult<T = undefined> = ({ ok: true } & (T extends undefined ? Record<never, never> : { data: T })) | { ok: false; error: string };

function zodText(e: ZodError): string {
  const i = e.issues[0];
  const field = i?.path[0];
  if (field === "port") return mailboxErrorText("PORT_NOT_ALLOWED");
  if (field === "host") return "Bitte nur den Servernamen eintragen (ohne Schema, Port oder Pfad, kein gesperrter Adressbereich).";
  if (field === "username") return "Bitte einen Benutzernamen eintragen.";
  if (field === "password") return "Das Passwort ist ungültig (1 bis 512 Zeichen).";
  if (field === "folder") return "Bitte einen Ordner eintragen.";
  if (field === "fetchSince") return "Bitte ein gültiges Datum eintragen.";
  if (field === "allowedSenderDomains") return "Bitte nur gültige Domains eintragen, eine je Zeile (höchstens 50).";
  if (field === "security") return "Port 993 gehört zu TLS, Port 143 zu STARTTLS.";
  return "Ungültige Eingabe.";
}

function failure(e: unknown, what: string): { ok: false; error: string } {
  if (e instanceof ZodError) return { ok: false, error: zodText(e) };
  if (e instanceof MailboxSettingsError || e instanceof InboundMailError) return { ok: false, error: mailboxErrorText(e.code) };
  if (e instanceof NotFoundError) return { ok: false, error: mailboxErrorText("NOT_FOUND") };
  if (e instanceof IncomingBusyError) return { ok: false, error: mailboxErrorText("BUSY") };
  if (e instanceof IncomingFormatError) return { ok: false, error: "Die Datei ist keine lesbare Rechnung." };
  if (e instanceof RateLimitError) return { ok: false, error: mailboxErrorText("COOLDOWN") };
  console.error(`Postfach ${what}:`, describeError(e));
  return { ok: false, error: GENERIC_MAILBOX_ERROR };
}

export async function saveMailboxSettingsCore(orgId: string, actor: string, input: unknown): Promise<UiResult<MailboxSettingsClientView>> {
  try {
    return { ok: true, data: toMailboxClientView(await saveMailboxSettings(orgId, input, actor)) };
  } catch (e) {
    return failure(e, "Einstellungen");
  }
}

/** Verbindungstest nur gegen den eingetragenen Server; `client` nur für Tests (Attrappe). */
export async function testMailboxCore(orgId: string, actor: string, client?: MailboxClient): Promise<UiResult<{ unseen: number; settings: MailboxSettingsClientView }>> {
  try {
    const r = await testMailboxConnection(orgId, actor, client);
    if (!r.ok) return { ok: false, error: mailboxErrorText(r.code) };
    return { ok: true, data: { unseen: r.unseen, settings: toMailboxClientView(await loadMailboxSettings(orgId)) } };
  } catch (e) {
    return failure(e, "Verbindungstest");
  }
}

export async function setMailboxEnabledCore(orgId: string, actor: string, enabled: boolean): Promise<UiResult<MailboxSettingsClientView>> {
  try {
    return { ok: true, data: toMailboxClientView(await setMailboxEnabled(orgId, enabled, actor)) };
  } catch (e) {
    return failure(e, "Schalter");
  }
}

/** Manueller Abruf nur des eigenen Postfachs (mit Sperre gegen den regulären Job); höchstens zweimal je Minute und Firma. */
export async function fetchMailboxNowCore(orgId: string, client?: MailboxClient): Promise<UiResult<{ staged: number; messages: number }>> {
  try {
    rateLimit(`mailbox-fetch-now:${orgId}`, { limit: 2, windowMs: 60_000 });
    const res = await runMailboxForOrg(orgId, new Date(), client);
    if (res.locked) return { ok: false, error: "Ein Abruf läuft bereits. Bitte später erneut versuchen." };
    if (res.error !== null) return { ok: false, error: GENERIC_MAILBOX_ERROR };
    return { ok: true, data: { staged: res.staged, messages: res.messages } };
  } catch (e) {
    return failure(e, "Abruf");
  }
}

export async function acceptAttachmentCore(orgId: string, actor: string, id: string): Promise<UiResult<{ incomingInvoiceId: string }>> {
  try {
    const r = await acceptInboundAttachment(orgId, id, actor);
    return { ok: true, data: { incomingInvoiceId: r.incomingInvoiceId } };
  } catch (e) {
    if (e instanceof InboundMailError && e.code === "ALREADY_RECEIVED") return { ok: false, error: mailboxErrorText("ALREADY_RECEIVED") };
    return failure(e, "Übernehmen");
  }
}

export async function acceptBatchCore(orgId: string, actor: string, ids: string[]): Promise<UiResult<{ entries: (AcceptBatchEntry & { error?: string })[] }>> {
  try {
    const entries = await acceptInboundAttachments(orgId, ids, actor);
    return { ok: true, data: { entries: entries.map((x) => (x.ok ? x : { ...x, error: mailboxErrorText(x.code) })) } };
  } catch (e) {
    return failure(e, "Sammel-Übernahme");
  }
}

export async function discardAttachmentCore(orgId: string, actor: string, id: string, reason: string | null): Promise<UiResult> {
  try {
    await discardInboundAttachment(orgId, id, reason === null || reason.trim() === "" ? {} : { reason }, actor);
    return { ok: true };
  } catch (e) {
    return failure(e, "Verwerfen");
  }
}

export async function restoreAttachmentCore(orgId: string, actor: string, id: string): Promise<UiResult> {
  try {
    await restoreInboundAttachment(orgId, id, actor);
    return { ok: true };
  } catch (e) {
    return failure(e, "Wiederherstellen");
  }
}
