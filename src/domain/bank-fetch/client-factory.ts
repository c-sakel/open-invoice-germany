/**
 * Einziger Zugang zum Bankprotokoll. Tests ersetzen `getFintsClient` per Modul-Attrappe; im Produkt gibt es keinen Test-Haken.
 */
import type { FintsClient } from "@/lib/fints/client";

/** Herstellerversion, die zusammen mit der Produkt-ID an die Bank gemeldet wird. */
export const FINTS_PRODUCT_VERSION = "1.0";

/** Der Adapter wird erst beim ersten Abruf geladen (die Bibliothek ist reines ESM; Generator- und Werkzeugläufe laden sie nie). */
export async function getFintsClient(): Promise<FintsClient> {
  const { createFintsClient } = await import("@/lib/fints/lib-fints-adapter");
  return createFintsClient();
}
