import { externalRequest } from "@/lib/http/external";
import { allowedPaymentHosts } from "./registry";
import { PaymentProviderError, type PaymentTransport } from "./types";

export class PaymentNetworkForbiddenError extends Error {
  constructor() {
    super("Netzzugriff auf Zahlungsanbieter ist in dieser Umgebung gesperrt.");
    this.name = "PaymentNetworkForbiddenError";
  }
}

/**
 * Netzsperre: unter Vitest, NODE_ENV=test oder PAYMENT_NETWORK=0. Ohne diese Marker ist der Zugriff in
 * Produktion gewollt offen (die Anbindung ist per Einstellung standardmaessig aus; Schluessel fehlen dann).
 */
export function paymentNetworkBlocked(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test" || process.env.PAYMENT_NETWORK === "0";
}

/** Prueft vor jedem Request: https und exakter Hostname aus der Allowlist der Anbieter. */
export function assertAllowedPaymentUrl(url: string, hosts: ReadonlySet<string> = allowedPaymentHosts()): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PaymentProviderError("invalid", "Ungueltige Anbieteradresse.");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !hosts.has(u.hostname)) {
    throw new PaymentProviderError("invalid", "Anbieteradresse nicht erlaubt.");
  }
}

/** Einziger Ort, an dem Anbieter-Aufrufe das Netz erreichen. */
export function defaultPaymentTransport(): PaymentTransport {
  return async (req) => {
    if (paymentNetworkBlocked()) throw new PaymentNetworkForbiddenError();
    assertAllowedPaymentUrl(req.url);
    return externalRequest(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      timeoutMs: 20_000,
      maxBytes: 1024 * 1024,
    });
  };
}
