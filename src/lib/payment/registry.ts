import { isTrustedCheckoutUrl } from "./checkout-url";
import { mollieAdapter } from "./mollie";
import type { OnlineProvider, PaymentProviderAdapter } from "./types";

export function adapterFor(provider: OnlineProvider): PaymentProviderAdapter {
  switch (provider) {
    case "MOLLIE":
      return mollieAdapter;
  }
}

/** Alle Hosts, die ein registrierter Anbieter erreichen darf (Quelle fuer die Allowlist im Transport). */
export function allowedPaymentHosts(): ReadonlySet<string> {
  return new Set([mollieAdapter].flatMap((a) => [...a.allowedHosts]));
}

/** Pruefung der Bezahladresse vor jeder Weiterleitung (auch bei Wiederverwendung aus der Datenbank). */
export function isTrustedPaymentCheckoutUrl(url: string): boolean {
  return [mollieAdapter].some((a) => isTrustedCheckoutUrl(url, a.checkoutHosts));
}
