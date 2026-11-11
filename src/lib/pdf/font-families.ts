/**
 * Auswaehlbare PDF-Schriftfamilien (Phase 16g). Reine Konstanten ohne Node-Abhaengigkeit,
 * damit Zod-Schemas und Client-Komponenten sie importieren koennen; die Dateizuordnung
 * liegt in `fonts.ts`.
 */
export const PDF_FONT_FAMILIES = ["liberation-sans", "ibm-plex-sans", "ibm-plex-serif", "source-serif-4", "inter"] as const;
export type PdfFontFamily = (typeof PDF_FONT_FAMILIES)[number];
export const DEFAULT_PDF_FONT_FAMILY: PdfFontFamily = "liberation-sans";
export const PDF_FONT_LABELS: Record<PdfFontFamily, string> = {
  "liberation-sans": "Liberation Sans (Standard)",
  "ibm-plex-sans": "IBM Plex Sans",
  "ibm-plex-serif": "IBM Plex Serif",
  "source-serif-4": "Source Serif 4",
  inter: "Inter",
};
