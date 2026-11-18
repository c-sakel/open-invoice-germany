/**
 * Netzpruefung fuer den Postfach-Abruf: nur Port 993 (TLS) und 143 (STARTTLS), Host einmal aufloesen,
 * alle Adressen gegen die Sperrliste, Verbindung auf die geprueften Adresse (kein erneutes DNS).
 */
import dns from "node:dns";
import net from "node:net";
import { z } from "zod";
import { MAIL_DNS_TIMEOUT_MS } from "@/domain/mailbox/limits";
import { isBlockedAddress as isBlockedAddressShared } from "@/lib/net/address-guard";
import { MailboxError } from "./client";

type Env = Readonly<Record<string, string | undefined>>;

export interface ResolvedTarget {
  host: string;
  address: string;
  family: 4 | 6;
  port: number;
}

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((h) => !/[\u0000- \u007f/\\:@?#%]/.test(h) || net.isIPv6(h), "Ungueltiger Host");

export function isBlockedAddress(address: string, env: Env = process.env): boolean {
  return isBlockedAddressShared(address, { allowPrivate: env.INBOUND_MAIL_ALLOW_PRIVATE === "1" });
}

export function assertAllowedPort(port: number, security: string): void {
  if (!((port === 993 && security === "TLS") || (port === 143 && security === "STARTTLS"))) {
    throw new MailboxError("PORT_NOT_ALLOWED");
  }
}

/** Netzsperre unter Vitest, NODE_ENV=test oder INBOUND_MAIL_NETWORK=0. */
export function mailboxNetworkBlocked(env: Env = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test" || env.INBOUND_MAIL_NETWORK === "0";
}

const defaultLookup: LookupFn = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Aufloesung mit Zeitgrenze; getaddrinfo kann sonst lange haengen. */
function lookupWithTimeout(lookup: LookupFn, host: string, timeoutMs: number): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new MailboxError("DNS_FAILED")), timeoutMs);
    lookup(host).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        reject(new MailboxError("DNS_FAILED"));
      },
    );
  });
}

function allowlist(env: Env): Set<string> | null {
  const raw = env.INBOUND_MAIL_HOSTS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

export async function resolveMailHost(
  host: string,
  port: number,
  opts: { lookup?: LookupFn; env?: Env; dnsTimeoutMs?: number } = {},
): Promise<ResolvedTarget> {
  const env = opts.env ?? process.env;
  const parsed = hostSchema.safeParse(host);
  if (!parsed.success) throw new MailboxError("HOST_NOT_ALLOWED");
  const name = parsed.data.toLowerCase();
  const allowed = allowlist(env);
  if (allowed && !allowed.has(name)) throw new MailboxError("HOST_NOT_ALLOWED");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupWithTimeout(opts.lookup ?? defaultLookup, name, opts.dnsTimeoutMs ?? MAIL_DNS_TIMEOUT_MS);
  } catch {
    throw new MailboxError("DNS_FAILED");
  }
  if (addresses.length === 0) throw new MailboxError("DNS_FAILED");
  // Eine gesperrte Adresse verbietet den Host (gemischte Antworten).
  if (addresses.some((a) => isBlockedAddress(a.address, env))) throw new MailboxError("HOST_BLOCKED");
  const first = addresses.find((a) => a.family === 4) ?? addresses[0];
  if (!first) throw new MailboxError("DNS_FAILED");
  return { host: name, address: first.address, family: first.family === 6 ? 6 : 4, port };
}
