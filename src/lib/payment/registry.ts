import { isTrustedCheckoutUrl } from "./checkout-url";
import { mollieAdapter } from "./mollie";
import { stripeAdapter } from "./stripe";
import type { OnlineProvider, PaymentProviderAdapter } from "./types";

const ALL_ADAPTERS: readonly PaymentProviderAdapter[] = [mollieAdapter, stripeAdapter];

export function adapterFor(provider: OnlineProvider): PaymentProviderAdapter {
  switch (provider) {
    case "MOLLIE":
      return mollieAdapter;
    case "STRIPE":
      return stripeAdapter;
  }
}

/** Alle Hosts, die ein registrierter Anbieter erreichen darf (Quelle fuer die Allowlist im Transport). */
export function allowedPaymentHosts(): ReadonlySet<string> {
  return new Set(ALL_ADAPTERS.flatMap((a) => [...a.allowedHosts]));
}

/** Pruefung der Bezahladresse vor jeder Weiterleitung (auch bei Wiederverwendung aus der Datenbank). */
export function isTrustedPaymentCheckoutUrl(url: string): boolean {
  return ALL_ADAPTERS.some((a) => isTrustedCheckoutUrl(url, a.checkoutHosts));
}
