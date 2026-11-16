/**
 * IMAP-Adapter. Kennt nur lesende Kommandos (Suche, Metadaten, Abruf) und das Setzen von \Seen; Nachrichten
 * werden nie geloescht, verschoben, kopiert oder angehaengt. Zugangsdaten gehen nur an imapflow; Server-
 * Meldungen werden verworfen, Fehler tragen nur einen festen Code.
 */
import { normalizeSenderDomain } from "@/schemas/mailbox";
import type { Readable } from "node:stream";
import { ImapFlow } from "imapflow";
import {
  MAIL_COMMAND_TIMEOUT_MS,
  MAIL_CONNECT_TIMEOUT_MS,
  MAX_SEARCH_UIDS,
} from "@/domain/mailbox/limits";
import {
  MailboxError,
  type MailboxAccount,
  type MailboxClient,
  type MailboxErrorCode,
  type MailboxSession,
} from "./client";
import { assertAllowedPort, mailboxNetworkBlocked, resolveMailHost, type ResolvedTarget } from "./net-guard";

/** Nur fuer Tests: umgeht Netzsperre und Sperrliste, nutzt eigene CA und festen Zielport. */
export interface TestConnector {
  ca: string | Buffer;
  target: (host: string) => ResolvedTarget;
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  authenticationFailed?: unknown;
  tlsFailed?: unknown;
  mailboxMissing?: unknown;
  serverResponseCode?: unknown;
}

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|EPROTO|STARTTLS)/;
const TIMEOUT_CODES = new Set(["ETIMEOUT", "GREETING_TIMEOUT", "CONNECTION_TIMEOUT", "ETIMEDOUT"]);
const CONNECT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EPIPE", "EAI_AGAIN"]);

/** Faelle aus dem Fehlerobjekt; Servertexte bleiben ungelesen ausser fuer die interne Zuordnung. */
export function mapMailboxError(err: unknown, oauthOnly = false): MailboxError {
  if (err instanceof MailboxError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as ErrorLike;
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  let result: MailboxErrorCode = "PROTOCOL_ERROR";
  if (e.authenticationFailed === true) result = oauthOnly ? "OAUTH_REQUIRED" : "AUTH_FAILED";
  else if (e.tlsFailed === true && /STARTTLS/i.test(message) && !TLS_CODE.test(code)) result = "STARTTLS_MISSING";
  else if (e.tlsFailed === true || TLS_CODE.test(code)) result = "TLS_FAILED";
  else if (TIMEOUT_CODES.has(code)) result = "TIMEOUT";
  else if (CONNECT_CODES.has(code)) result = "CONNECT_FAILED";
  else if (e.mailboxMissing === true || e.serverResponseCode === "NONEXISTENT") result = "FOLDER_NOT_FOUND";
  // Nur der Name der Ursache, nie Text oder Zugangsdaten.
  console.error(`[mailbox] ${result} (${code || (err instanceof Error ? err.name : "unknown")})`);
  return new MailboxError(result);
}

async function readLimited(stream: Readable, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      throw new MailboxError("TOO_LARGE");
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function oauthOnlyCapabilities(client: ImapFlow): boolean {
  const caps: { has(key: string): boolean } | undefined = client.capabilities;
  if (!caps || typeof caps.has !== "function") return false;
  const has = (c: string) => caps.has(c);
  const oauth = has("AUTH=XOAUTH2") || has("AUTH=OAUTHBEARER");
  const password = has("AUTH=PLAIN") || has("AUTH=LOGIN");
  return oauth && (!password || has("LOGINDISABLED"));
}

export function createImapClient(opts: { connector?: TestConnector } = {}): MailboxClient {
  const connector = opts.connector;
  return {
    async open(account: MailboxAccount): Promise<MailboxSession> {
      assertAllowedPort(account.port, account.security);
      let target: ResolvedTarget;
      if (connector) {
        target = connector.target(account.host);
      } else {
        if (mailboxNetworkBlocked()) throw new MailboxError("NETWORK_BLOCKED");
        target = await resolveMailHost(account.host, account.port);
      }
      const starttls = account.security === "STARTTLS";
      const client = new ImapFlow({
        host: target.address,
        port: target.port,
        secure: !starttls,
        doSTARTTLS: starttls,
        servername: target.host,
        auth: { user: account.username, pass: account.password },
        tls: {
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ...(connector ? { ca: connector.ca } : {}),
        },
        logger: false,
        disableCompression: true,
        disableAutoIdle: true,
        clientInfo: { name: "OpenInvoice" },
        connectionTimeout: MAIL_CONNECT_TIMEOUT_MS,
        greetingTimeout: MAIL_CONNECT_TIMEOUT_MS,
        socketTimeout: MAIL_COMMAND_TIMEOUT_MS,
      });
      // Ohne Handler wuerde ein Socket-Fehler den Prozess beenden.
      client.on("error", () => undefined);
      const fail = (err: unknown): never => {
        const mapped = mapMailboxError(err, oauthOnlyCapabilities(client));
        client.close();
        throw mapped;
      };
      let uidValidity: string;
      try {
        await client.connect();
        const mb = await client.mailboxOpen(account.folder);
        uidValidity = String(mb.uidValidity);
      } catch (err) {
        return fail(err);
      }
      const run = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          const mapped = mapMailboxError(err);
          client.close();
          throw mapped;
        }
      };
      return {
        uidValidity,
        searchUnseen: (since) =>
          run(async () => {
            const found = await client.search(since ? { seen: false, since } : { seen: false }, { uid: true });
            if (!Array.isArray(found)) return [];
            return found
              .slice()
              .sort((a, b) => a - b)
              .slice(0, MAX_SEARCH_UIDS)
              .map(String);
          }),
        meta: (uid) =>
          run(async () => {
            const m = await client.fetchOne(uid, { size: true, internalDate: true, envelope: true }, { uid: true });
            if (!m) return null;
            const d = m.internalDate ? new Date(m.internalDate) : null;
            return {
              size: typeof m.size === "number" ? m.size : 0,
              internalDate: d !== null && Number.isFinite(d.getTime()) ? d : null,
              fromDomain: envelopeDomain(m.envelope?.from?.[0]?.address),
            };
          }),
        fetchRaw: (uid, maxBytes) =>
          run(async () => {
            const dl = await client.download(uid, undefined, { uid: true, maxBytes: maxBytes + 1 });
            if (!dl.content) throw new MailboxError("PROTOCOL_ERROR");
            return readLimited(dl.content, maxBytes);
          }),
        markSeen: (uid) =>
          run(async () => {
            await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          }),
        countUnseen: () =>
          run(async () => {
            const found = await client.search({ seen: false }, { uid: true });
            return Array.isArray(found) ? found.length : 0;
          }),
        close: async () => {
          try {
            await client.logout();
          } catch {
            client.close();
          }
        },
      };
    },
  };
}

/** Domain der Absenderadresse aus dem Envelope; null, wenn sie fehlt oder ungueltig ist. */
function envelopeDomain(address: unknown): string | null {
  if (typeof address !== "string") return null;
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const d = normalizeSenderDomain(address.slice(at + 1));
  return d.length > 0 ? d : null;
}
