/**
 * Aufgeloeste Markenangaben fuer die App-Huellen (Phase 12c). NULL-Felder in
 * BrandingSettings bedeuten "Produktvorgabe" — die Vorgabewerte selbst stehen in
 * `@/lib/brand-defaults` (die EINZIGE Stelle mit den Literalen; hier nur re-exportiert,
 * damit bestehende Importe von hier weiter funktionieren). Die AGPL-Herkunftszeile ist
 * bewusst NICHT Teil von `Brand`: sie ist in AppShell/SlimShell fest verdrahtet und durch
 * keine Einstellung abschaltbar (§13 AGPL, COMPLIANCE.md).
 */
import { loadBrandingSettings } from "@/domain/settings/branding";
import type { BrandingSettingsInput } from "@/schemas/settings";
import { DEFAULT_APP_NAME, DEFAULT_APP_SHORT_NAME } from "@/lib/brand-defaults";

export { DEFAULT_APP_NAME, DEFAULT_APP_SHORT_NAME };

/** Quellcode-Link der AGPL-Zeile. Ein Fork darf hier seine eigene Quelle eintragen — die
 *  Herkunftsangabe selbst bleibt (AGPL §13: Zugang zum Quellcode, nicht Namensverzicht). */
export const SOURCE_URL = process.env.SOURCE_URL ?? "https://github.com/automationsmanufaktur-labs/open-invoice-germany";

export interface Brand {
  appName: string;
  appShortName: string;
  hasAppLogo: boolean;
}

export const DEFAULT_BRAND: Brand = { appName: DEFAULT_APP_NAME, appShortName: DEFAULT_APP_SHORT_NAME, hasAppLogo: false };

export function resolveBrand(b: Pick<BrandingSettingsInput, "appName" | "appShortName" | "appLogoPath">): Brand {
  return {
    appName: b.appName ?? DEFAULT_APP_NAME,
    appShortName: b.appShortName ?? DEFAULT_APP_SHORT_NAME,
    hasAppLogo: Boolean(b.appLogoPath),
  };
}

/** Laedt die Marke einer Organisation; ohne gespeicherte Zeile gelten die Produktvorgaben. */
export async function loadBrand(orgId: string): Promise<Brand> {
  return resolveBrand(await loadBrandingSettings(orgId));
}
