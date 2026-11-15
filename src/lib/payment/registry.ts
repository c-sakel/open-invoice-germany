import { mollieAdapter } from "./mollie";
import type { OnlineProvider, PaymentProviderAdapter } from "./types";

export function adapterFor(provider: OnlineProvider): PaymentProviderAdapter {
  switch (provider) {
    case "MOLLIE":
      return mollieAdapter;
  }
}
