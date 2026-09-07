/**
 * PDF-Theme: Briefpapier (BrandingSettings) + effektive Druckoptionen, optional geladene
 * Logo-/Hintergrundbild-Buffer. Reiner Typ — das Laden (inkl. Dateizugriff) übernimmt
 * `src/domain/settings/theme.ts` (`loadPdfTheme`), damit dieses Modul framework-/DB-frei
 * bleibt und in den Renderern ohne Zyklen importiert werden kann.
 */
import type { BrandingSettingsInput, PrintSettingsInput } from "@/schemas/settings";
import type { LayoutId } from "./layouts/ids";

/** Die effektiven (Global + Beleg-Override verschmolzenen) Druckoptionen, siehe
 *  `effectivePrintOptions` in `src/domain/settings/print.ts`. */
export type EffectivePrintOptions = PrintSettingsInput;

/** Phase 11b — Zusatzfakten fuer die automatische Fusszeile (`footer.ts#buildFooterColumns`),
 *  die nicht Teil von `EInvoiceData`/`DeliveryNotePdfData`/`DunningPdfData` sind, sondern aus
 *  `Organization` kommen. */
export interface PdfFooterFacts {
  website?: string | null;
  ownerName?: string | null;
}

export interface PdfTheme {
  brand: BrandingSettingsInput;
  options: EffectivePrintOptions;
  /** Phase 11b — aufgeloeste Layout-Kennung (Beleg-Override > Typ-Map > Organisation). */
  layoutId: LayoutId;
  /** Phase 11b — Zusatzfakten fuer die AUTO-Fusszeile, die nicht in EInvoiceData stehen. */
  footerFacts: PdfFooterFacts;
  /** Logo-Bilddaten, wenn `brand.logoPath` gesetzt ist UND die Datei lesbar war. */
  logoBuffer?: Buffer;
  /** Hintergrundbild-Daten, wenn `brand.showBackground` an ist UND die Datei lesbar war. */
  backgroundBuffer?: Buffer;
  /** Phase 7, Task 1 (§33) — DocumentSettings.showPaymentTermsText: Zahlungsziel-/
   *  Skonto-Text ("Zahlbar bis ..."/paymentTermsHuman) im PDF nur wenn an. Von
   *  `loadPdfTheme` aus DocumentSettings geladen (nicht Teil von PrintSettings/
   *  BrandingSettings, daher ein eigenes Top-Level-Feld statt unter `options`). */
  showPaymentTermsText: boolean;
  /**
   * Fix-Runde 1 (Koordinator): Content-Stream-Kompression (`PDFDocument({compress})`).
   * Produktionspfad MUSS komprimieren (Default `true`, wenn `undefined`) — `false` ist
   * NUR fuer Tests gedacht, die den PDF-Text mit `pdf-parse` (Version 1.1.1, buendelt
   * eine sehr alte pdf.js-Version) extrahieren: diese wirft bei EINIGEN strukturell
   * validen, komprimierten pdfkit-PDFs `bad XRef entry` (verifiziert mit `qpdf --check`/
   * `pdftotext`: dieselben Dateien sind gueltig). `testPdfTheme()`
   * (test/helpers/pdf-theme.ts) setzt deshalb `false`; echte Aufrufer (`loadPdfTheme`)
   * setzen dieses Feld NICHT — Produktions-PDFs sind immer komprimiert.
   */
  compress?: boolean;
}
