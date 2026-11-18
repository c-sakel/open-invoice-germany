/**
 * Einziger Zugang zum Bankprotokoll. Tests ersetzen `getFintsClient` per Modul-Attrappe; im Produkt gibt es keinen Test-Haken.
 */
import type { FintsClient } from "@/lib/fints/client";
import { createFintsClient } from "@/lib/fints/lib-fints-adapter";

/** Herstellerversion, die zusammen mit der Produkt-ID an die Bank gemeldet wird. */
export const FINTS_PRODUCT_VERSION = "1.0";

export function getFintsClient(): FintsClient {
  return createFintsClient();
}
