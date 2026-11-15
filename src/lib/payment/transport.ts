import { externalRequest } from "@/lib/http/external";
import type { PaymentTransport } from "./types";

export class PaymentNetworkForbiddenError extends Error {
  constructor() {
    super("Netzzugriff auf Zahlungsanbieter ist in dieser Umgebung gesperrt.");
    this.name = "PaymentNetworkForbiddenError";
  }
}

/** Einziger Ort, an dem Anbieter-Aufrufe das Netz erreichen. Unter Vitest oder PAYMENT_NETWORK=0 gesperrt. */
export function defaultPaymentTransport(): PaymentTransport {
  return async (req) => {
    if (process.env.VITEST || process.env.PAYMENT_NETWORK === "0") throw new PaymentNetworkForbiddenError();
    return externalRequest(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      timeoutMs: 20_000,
      maxBytes: 1024 * 1024,
    });
  };
}
