/**
 * TOTP (Phase 17d): Einmalpasswoerter nach RFC 6238 auf Basis von HOTP (RFC 4226),
 * HMAC-SHA1, 30 s, 6 Ziffern; Geheimnis als Base32 (RFC 4648) fuer Authenticator-Apps.
 * Nur `node:crypto`; Codevergleiche zeitkonstant.
 *
 * Quellen: RFC 4226 (HOTP, Anhang D Testwerte), RFC 6238 (TOTP, Anhang B), RFC 4648 (Base32).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
/** Toleranz in Schritten vor/nach dem aktuellen (Uhrenabweichung). */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 Base32, Grossbuchstaben, ohne Auffuellung. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Ignoriert Leerzeichen, "=" und Kleinschreibung; wirft bei fremdem Zeichen. */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Ungueltiges Base32-Zeichen");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** HOTP nach RFC 4226: Zaehler als 8-Byte-Big-Endian, dynamische Kuerzung. */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(buf).digest();
  const offset = h[19]! & 0x0f;
  const bin =
    ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_S);
}

/**
 * Prueft `code` gegen alle Schritte `s-window … s+window` (ohne fruehe Rueckkehr, Vergleich
 * zeitkonstant). Liefert den groessten getroffenen Schritt `> lastStep` oder `null`.
 * Replay-Schutz: der Aufrufer speichert den Schritt per bedingtem `updateMany`.
 */
export function matchTotp(
  secret: Uint8Array,
  code: string,
  now: Date,
  opts: { lastStep?: number | null; window?: number } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const window = opts.window ?? TOTP_WINDOW;
  const lastStep = opts.lastStep ?? null;
  const current = totpStep(now);
  const given = Buffer.from(code, "utf8");
  let best: number | null = null;
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secret, step), "utf8");
    const ok = timingSafeEqual(given, expected);
    if (ok && (lastStep === null || step > lastStep) && (best === null || step > best)) best = step;
  }
  return best;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** otpauth://-URI fuer QR-Code/Authenticator (Key-URI-Format). */
export function otpauthUri(p: { secret: Uint8Array; account: string; issuer: string }): string {
  const issuer = encodeURIComponent(p.issuer);
  const label = `${issuer}:${encodeURIComponent(p.account)}`;
  return `otpauth://totp/${label}?secret=${base32Encode(p.secret)}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`;
}
