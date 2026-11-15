import { createHmac, timingSafeEqual } from "node:crypto";

export const STRIPE_SIGNATURE_TOLERANCE_S = 300;

const T_PATTERN = /^\d{1,12}$/;
const V1_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Prueft den Kopf `Stripe-Signature` ueber die unveraenderten Rohbytes. Nur `t` und `v1` zaehlen,
 * alle anderen Eintraege (z. B. `v0`) werden ignoriert. Vergleich in konstanter Laufzeit.
 */
export function verifyStripeSignature(raw: Buffer, header: string | null, secret: string, now: Date): "OK" | "SIGNATURE" | "STALE" | "FORMAT" {
  if (!header || header.length > 2048) return "FORMAT";
  const ts: string[] = [];
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name === "t") ts.push(value);
    else if (name === "v1" && V1_PATTERN.test(value)) sigs.push(value);
  }
  const t = ts[0];
  if (ts.length !== 1 || t === undefined || !T_PATTERN.test(t) || sigs.length === 0) return "FORMAT";
  const expected = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), raw])).digest();
  let match = false;
  for (const s of sigs) {
    if (timingSafeEqual(expected, Buffer.from(s, "hex"))) match = true;
  }
  if (!match) return "SIGNATURE";
  return Math.abs(now.getTime() / 1000 - Number(t)) > STRIPE_SIGNATURE_TOLERANCE_S ? "STALE" : "OK";
}
