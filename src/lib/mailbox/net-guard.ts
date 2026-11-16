/**
 * Netzpruefung fuer den Postfach-Abruf: nur Port 993 (TLS) und 143 (STARTTLS), Host einmal aufloesen,
 * alle Adressen gegen die Sperrliste, Verbindung auf die geprueften Adresse (kein erneutes DNS).
 */
import dns from "node:dns";
import net from "node:net";
import { z } from "zod";
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

function makeList(entries: [string, number, "ipv4" | "ipv6"][]): net.BlockList {
  const list = new net.BlockList();
  for (const [addr, prefix, family] of entries) list.addSubnet(addr, prefix, family);
  return list;
}

/** Immer gesperrt, auch mit INBOUND_MAIL_ALLOW_PRIVATE=1. Bewusst ohne ::ffff:0:0/96 (sperrt in Node jede IPv4). */
const ALWAYS = makeList([
  ["0.0.0.0", 8, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["::", 96, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
]);

/** Private und reservierte Bereiche; nur diese hebt INBOUND_MAIL_ALLOW_PRIVATE auf. */
const PRIVATE = makeList([
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["fc00::", 7, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["2001::", 32, "ipv6"],
]);

/** IPv4-mapped IPv6 (::ffff:a.b.c.d oder ::ffff:hhhh:hhhh) auf IPv4 zurueckfuehren. */
function unmap(address: string): string {
  const a = address.toLowerCase().split("%")[0] ?? "";
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return a;
}

export function isBlockedAddress(address: string, env: Env = process.env): boolean {
  const a = unmap(address);
  const family = net.isIP(a);
  if (family === 0) return true;
  const kind = family === 4 ? "ipv4" : "ipv6";
  if (ALWAYS.check(a, kind)) return true;
  if (env.INBOUND_MAIL_ALLOW_PRIVATE === "1") return false;
  return PRIVATE.check(a, kind);
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

function allowlist(env: Env): Set<string> | null {
  const raw = env.INBOUND_MAIL_HOSTS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

export async function resolveMailHost(
  host: string,
  port: number,
  opts: { lookup?: LookupFn; env?: Env } = {},
): Promise<ResolvedTarget> {
  const env = opts.env ?? process.env;
  const parsed = hostSchema.safeParse(host);
  if (!parsed.success) throw new MailboxError("HOST_NOT_ALLOWED");
  const name = parsed.data.toLowerCase();
  const allowed = allowlist(env);
  if (allowed && !allowed.has(name)) throw new MailboxError("HOST_NOT_ALLOWED");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await (opts.lookup ?? defaultLookup)(name);
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
