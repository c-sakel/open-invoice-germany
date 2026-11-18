/**
 * Netzpruefung fuer den Kontoabruf: nur https auf Port 443 ohne Zugangsdaten, Query und Fragment, Host einmal
 * aufloesen, alle Adressen gegen die Sperrliste. Die Verbindung geht danach auf die geprueften Adresse (kein erneutes DNS).
 */
import dns from "node:dns";
import net from "node:net";
import { FINTS_DNS_TIMEOUT_MS } from "@/domain/bank-fetch/limits";
import { isBlockedAddress } from "@/lib/net/address-guard";
import { FintsError } from "./client";

type Env = Readonly<Record<string, string | undefined>>;

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

const MAX_PATH = 200;
const MAX_HOST = 253;

/** Zerlegt die FinTS-Adresse der Bank; alles ausser einer schlichten https-Adresse ist `URL_INVALID`. */
export function parseFintsUrl(raw: string): { host: string; path: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) throw new FintsError("URL_INVALID");
  // Steuerzeichen, Leerraum, Backslash, Prozentkodierung, Query und Fragment schon im Rohtext ablehnen (URL normalisiert sie weg).
  if (/[\u0000- \u007f-\u009f\\?#%]/.test(raw)) throw new FintsError("URL_INVALID");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FintsError("URL_INVALID");
  }
  if (url.protocol !== "https:") throw new FintsError("URL_INVALID");
  if (url.username !== "" || url.password !== "") throw new FintsError("URL_INVALID");
  if (url.port !== "" && url.port !== "443") throw new FintsError("URL_INVALID");
  if (url.search !== "" || url.hash !== "") throw new FintsError("URL_INVALID");
  const host = url.hostname.toLowerCase();
  if (host === "" || host.length > MAX_HOST || host.includes("[") || host.includes(":")) throw new FintsError("URL_INVALID");
  const path = url.pathname === "" ? "/" : url.pathname;
  if (path.length > MAX_PATH) throw new FintsError("URL_INVALID");
  return { host, path };
}

/** Netzsperre unter Vitest, NODE_ENV=test oder FINTS_NETWORK=0. */
export function fintsNetworkBlocked(env: Env = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test" || env.FINTS_NETWORK === "0";
}

const defaultLookup: LookupFn = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

function lookupWithTimeout(lookup: LookupFn, host: string, timeoutMs: number): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new FintsError("DNS_FAILED")), timeoutMs);
    lookup(host).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        reject(new FintsError("DNS_FAILED"));
      },
    );
  });
}

function allowlist(env: Env): Set<string> | null {
  const raw = env.FINTS_HOSTS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

export async function resolveFintsHost(
  host: string,
  opts: { lookup?: LookupFn; env?: Env; dnsTimeoutMs?: number } = {},
): Promise<{ host: string; address: string; family: 4 | 6 }> {
  const env = opts.env ?? process.env;
  const name = host.toLowerCase();
  if (name === "" || name.length > MAX_HOST || /[\u0000- \u007f/\\:@?#%[\]]/.test(name)) throw new FintsError("URL_INVALID");
  const allowed = allowlist(env);
  if (allowed && !allowed.has(name)) throw new FintsError("HOST_NOT_ALLOWED");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupWithTimeout(opts.lookup ?? defaultLookup, name, opts.dnsTimeoutMs ?? FINTS_DNS_TIMEOUT_MS);
  } catch {
    throw new FintsError("DNS_FAILED");
  }
  if (addresses.length === 0) throw new FintsError("DNS_FAILED");
  // Eine gesperrte Adresse verbietet den Host (gemischte Antworten); kein Freigabeschalter fuer private Bereiche.
  if (addresses.some((a) => !net.isIP(a.address) || isBlockedAddress(a.address))) throw new FintsError("HOST_BLOCKED");
  const first = addresses.find((a) => a.family === 4) ?? addresses[0];
  if (!first) throw new FintsError("DNS_FAILED");
  return { host: name, address: first.address, family: first.family === 6 ? 6 : 4 };
}
