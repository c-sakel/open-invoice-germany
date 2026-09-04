/**
 * PDF-Theme: Briefpapier (BrandingSettings) + effektive Druckoptionen, optional geladene
 * Logo-/Hintergrundbild-Buffer. Reiner Typ — das Laden (inkl. Dateizugriff) übernimmt
 * `src/domain/settings/theme.ts` (`loadPdfTheme`), damit dieses Modul framework-/DB-frei
 * bleibt und in den Renderern ohne Zyklen importiert werden kann.
 */
import type { BrandingSettingsInput, PrintSettingsInput } from "@/schemas/settings";

/** Die effektiven (Global + Beleg-Override verschmolzenen) Druckoptionen, siehe
 *  `effectivePrintOptions` in `src/domain/settings/print.ts`. */
export type EffectivePrintOptions = PrintSettingsInput;

export interface PdfTheme {
  brand: BrandingSettingsInput;
  options: EffectivePrintOptions;
  /** Logo-Bilddaten, wenn `brand.logoPath` gesetzt ist UND die Datei lesbar war. */
  logoBuffer?: Buffer;
  /** Hintergrundbild-Daten, wenn `brand.showBackground` an ist UND die Datei lesbar war. */
  backgroundBuffer?: Buffer;
}
