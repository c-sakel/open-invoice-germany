/**
 * Gemeinsame Sperrliste fuer ausgehende Verbindungen zu fremden Servern (Postfach-Abruf, Kontoabruf):
 * Loopback, Link-Local/Metadaten, Multicast, private und reservierte Bereiche, Uebergangsadressen.
 */
import net from "node:net";

function makeList(entries: [string, number, "ipv4" | "ipv6"][]): net.BlockList {
  const list = new net.BlockList();
  for (const [addr, prefix, family] of entries) list.addSubnet(addr, prefix, family);
  return list;
}

/** Immer gesperrt, auch mit freigegebenen privaten Bereichen. Bewusst ohne ::ffff:0:0/96 (sperrt in Node jede IPv4). */
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
  // 6to4 und Teredo betten beliebige IPv4-Adressen ein.
  ["2002::", 16, "ipv6"],
  ["2001::", 32, "ipv6"],
]);

/** Private und reservierte Bereiche; nur diese hebt `allowPrivate` auf. */
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

export function isBlockedAddress(address: string, opts: { allowPrivate?: boolean } = {}): boolean {
  const a = unmap(address);
  const family = net.isIP(a);
  if (family === 0) return true;
  const kind = family === 4 ? "ipv4" : "ipv6";
  if (ALWAYS.check(a, kind)) return true;
  if (opts.allowPrivate === true) return false;
  return PRIVATE.check(a, kind);
}
