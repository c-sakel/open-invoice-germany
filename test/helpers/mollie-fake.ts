import { readFileSync } from "node:fs";
import path from "node:path";
import type { PaymentTransport, PaymentTransportRequest } from "@/lib/payment/types";

export const FAKE_TEST_KEY = "test_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FAKE_LIVE_KEY = "live_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export function mollieFixture(name: string): string {
  return readFileSync(path.join(process.cwd(), "test/fixtures/mollie", `${name}.json`), "utf8");
}

type Reply = { status: number; text: string };
type Handler = Reply | ((req: PaymentTransportRequest) => Reply);

/** Fake-Transport fuer Tests: protokolliert alle Aufrufe, antwortet nach "METHOD /pfad". Kein Netz. */
export function createMollieFake(routes: Record<string, Handler> = {}) {
  const calls: PaymentTransportRequest[] = [];
  const transport: PaymentTransport = async (req) => {
    calls.push(req);
    const p = new URL(req.url).pathname.replace(/^\/v2/, "");
    const h = routes[`${req.method} ${p}`];
    if (!h) return { status: 404, text: "{}" };
    return typeof h === "function" ? h(req) : h;
  };
  return { transport, calls, routes };
}
