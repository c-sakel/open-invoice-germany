import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STRIPE_SIGNATURE_TOLERANCE_S, verifyStripeSignature } from "@/lib/payment/stripe-signature";
import { FAKE_STRIPE_SIGNING_SECRET as SECRET, signStripeEvent } from "../helpers/stripe-fake";

const NOW = new Date("2026-11-15T10:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);
const BODY = '{"id":"evt_FAKEaaaa0001","object":"event"}';
const raw = Buffer.from(BODY, "utf8");

describe("Stripe-Signatur", () => {
  it("akzeptiert eine gueltige Signatur", () => {
    expect(verifyStripeSignature(raw, signStripeEvent(raw, SECRET, T), SECRET, NOW)).toBe("OK");
  });
  it("akzeptiert, wenn nur eines von mehreren v1 passt", () => {
    const good = signStripeEvent(raw, SECRET, T);
    const bad = `v1=${"0".repeat(64)}`;
    expect(verifyStripeSignature(raw, `${bad},${good}`, SECRET, NOW)).toBe("OK");
    expect(verifyStripeSignature(raw, `${good},${bad}`, SECRET, NOW)).toBe("OK");
    expect(verifyStripeSignature(raw, `t=${T},${bad},v1=${"1".repeat(64)}`, SECRET, NOW)).toBe("SIGNATURE");
  });
  it("nur v0 -> FORMAT; fehlender Kopf -> FORMAT; fehlendes t -> FORMAT", () => {
    expect(verifyStripeSignature(raw, `t=${T},v0=${"a".repeat(64)}`, SECRET, NOW)).toBe("FORMAT");
    expect(verifyStripeSignature(raw, null, SECRET, NOW)).toBe("FORMAT");
    expect(verifyStripeSignature(raw, "", SECRET, NOW)).toBe("FORMAT");
    expect(verifyStripeSignature(raw, `v1=${"a".repeat(64)}`, SECRET, NOW)).toBe("FORMAT");
    expect(verifyStripeSignature(raw, `t=abc,v1=${"a".repeat(64)}`, SECRET, NOW)).toBe("FORMAT");
    expect(verifyStripeSignature(raw, `t=${T},t=${T},v1=${"a".repeat(64)}`, SECRET, NOW)).toBe("FORMAT");
  });
  it("manipulierter Body oder falsches Secret -> SIGNATURE", () => {
    const h = signStripeEvent(raw, SECRET, T);
    expect(verifyStripeSignature(Buffer.from(BODY + " ", "utf8"), h, SECRET, NOW)).toBe("SIGNATURE");
    expect(verifyStripeSignature(raw, h, SECRET + "x", NOW)).toBe("SIGNATURE");
  });
  it("Toleranz 300 s in beide Richtungen", () => {
    expect(STRIPE_SIGNATURE_TOLERANCE_S).toBe(300);
    expect(verifyStripeSignature(raw, signStripeEvent(raw, SECRET, T - 300), SECRET, NOW)).toBe("OK");
    expect(verifyStripeSignature(raw, signStripeEvent(raw, SECRET, T + 300), SECRET, NOW)).toBe("OK");
    expect(verifyStripeSignature(raw, signStripeEvent(raw, SECRET, T - 301), SECRET, NOW)).toBe("STALE");
    expect(verifyStripeSignature(raw, signStripeEvent(raw, SECRET, T + 301), SECRET, NOW)).toBe("STALE");
  });
  it("ignoriert zusaetzliche Eintraege", () => {
    const h = signStripeEvent(raw, SECRET, T, ["destination=we_FAKE", "payload=x", "v0=zzz", "ohneGleich"]);
    expect(verifyStripeSignature(raw, h, SECRET, NOW)).toBe("OK");
  });
  it("prueft die Rohbytes unveraendert (CRLF, nicht-UTF-8-Folgen)", () => {
    const bytes = Buffer.concat([Buffer.from('{"a":1}\r\n'), Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a])]);
    const v1 = createHmac("sha256", SECRET).update(Buffer.concat([Buffer.from(`${T}.`), bytes])).digest("hex");
    expect(verifyStripeSignature(bytes, `t=${T},v1=${v1}`, SECRET, NOW)).toBe("OK");
    // Normalisierte Zeilenenden waeren eine andere Nachricht.
    expect(verifyStripeSignature(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")), `t=${T},v1=${v1}`, SECRET, NOW)).toBe("SIGNATURE");
  });
});
