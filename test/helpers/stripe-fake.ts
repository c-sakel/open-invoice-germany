import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PaymentTransport, PaymentTransportRequest } from "@/lib/payment/types";

// Fiktive Schluessel nur zur Laufzeit zusammengesetzt (kein Literal im Quelltext).
const SECRET_BODY = "FAKE" + "a".repeat(28);
export const FAKE_STRIPE_TEST_KEY = ["sk", "test", SECRET_BODY].join("_");
export const FAKE_STRIPE_LIVE_KEY = ["sk", "live", SECRET_BODY].join("_");
export const FAKE_STRIPE_RESTRICTED_LIVE_KEY = ["rk", "live", SECRET_BODY].join("_");
export const FAKE_STRIPE_PUBLISHABLE_KEY = ["pk", "live", SECRET_BODY].join("_");
export const FAKE_STRIPE_SIGNING_SECRET = ["whsec", "FAKE" + "b".repeat(28)].join("_");

export function stripeFixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "test/fixtures/stripe", `${name}.json`), "utf8");
}

/** Fixture mit ueberschriebenen Feldern der obersten Ebene. */
export function stripeFixtureWith(name: string, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(stripeFixture(name)) as Record<string, unknown>), ...patch });
}

/** Stripe-Signaturkopf `t=<sek>,v1=<hex>` ueber die Rohbytes. */
export function signStripeEvent(raw: string | Buffer, secret: string, t: number, extra: string[] = []): string {
  const body = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const v1 = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), body])).digest("hex");
  return [`t=${t}`, `v1=${v1}`, ...extra].join(",");
}

type Reply = { status: number; text: string };
type Handler = Reply | ((req: PaymentTransportRequest) => Reply);

/** Fake-Transport: protokolliert alle Aufrufe, antwortet nach "METHOD /pfad" (ohne /v1). Kein Netz. */
export function createStripeFake(routes: Record<string, Handler> = {}) {
  const calls: PaymentTransportRequest[] = [];
  const transport: PaymentTransport = async (req) => {
    calls.push(req);
    const p = new URL(req.url).pathname.replace(/^\/v1/, "");
    const h = routes[`${req.method} ${p}`];
    if (!h) return { status: 404, text: "{}" };
    return typeof h === "function" ? h(req) : h;
  };
  return { transport, calls, routes };
}
