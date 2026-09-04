/**
 * SSRF-Schutz fuer Webhook-Ziel-URLs (Phase 10, Task 5, task-5-facts.md "SSRF"): nur
 * https, Hostname wird per DNS aufgeloest (dns.lookup, ALLE Adressen — IPv4 und IPv6),
 * private/link-local/loopback-Netze sind verboten. Wird sowohl bei Anlage/Aenderung
 * eines Endpunkts (400, src/domain/webhook/endpoints.ts) als auch VOR jeder Zustellung
 * aufgerufen (Skip statt Fehler, src/domain/webhook/deliver.ts) — ein zum Anlagezeitpunkt
 * oeffentlicher Host koennte per DNS-Rebinding zwischenzeitlich auf ein privates Netz
 * zeigen.
 */
import dns from "node:dns/promises";
import net from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16 (task-5-facts.md, woertlich). */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // unparsebar -> sicherheitshalber blockieren
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true; // "diese Netz" (RFC 5735) — kein sinnvolles Zustellziel
  return false;
}

/** ::1 (Loopback), fe80::/10 (Link-Local), fc00::/7 (Unique Local/ULA) — task-5-facts.md nennt ::1 explizit. */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — dieselbe Pruefung auf den eingebetteten IPv4-Teil.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * Wirft `SsrfBlockedError`, wenn `urlStr` kein https ist, keine gueltige URL ist, oder
 * mindestens eine aufgeloeste Adresse in einem verbotenen Netz liegt. `lookupImpl` ist
 * fuer Tests injizierbar (kein echter DNS-Zugriff auf Literale wie "10.0.0.1" noetig,
 * aber Injektion erlaubt deterministische Tests fuer echte Hostnamen).
 */
export async function assertPublicHttpsUrl(
  urlStr: string,
  opts: { lookupImpl?: typeof dns.lookup } = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SsrfBlockedError("Ungueltige URL.");
  }
  if (url.protocol !== "https:") {
    throw new SsrfBlockedError("Nur https:// ist als Webhook-Ziel erlaubt.");
  }

  const lookup = opts.lookupImpl ?? dns.lookup;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new SsrfBlockedError(`Hostname "${url.hostname}" konnte nicht aufgeloest werden.`);
  }

  for (const a of addresses) {
    const family = net.isIP(a.address);
    if (family === 4 && isPrivateIPv4(a.address)) {
      throw new SsrfBlockedError(`Ziel-IP ${a.address} liegt in einem privaten/lokalen Netz — nicht erlaubt.`);
    }
    if (family === 6 && isPrivateIPv6(a.address)) {
      throw new SsrfBlockedError(`Ziel-IP ${a.address} liegt in einem privaten/lokalen Netz — nicht erlaubt.`);
    }
  }
}
