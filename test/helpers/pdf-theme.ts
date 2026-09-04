/**
 * Test-Hilfe (Phase 7, Task 3): ein `PdfTheme` mit reinen Defaults (Briefpapier +
 * Druckoptionen), ohne Logo/Hintergrund-Datei — für PDF-Renderer-Tests, die kein
 * eigenes Theme brauchen. `structuredClone`, damit kein Test versehentlich die
 * gemeinsame Default-Instanz mutiert.
 *
 * Fix-Runde 1 (Koordinator): `compress: false` (NUR hier / an expliziten Test-Call-
 * Sites, NIE im Produktionspfad — dort ist der Default `true`, siehe PdfTheme.compress)
 * — sonst wirft `pdf-parse` (buendelt eine sehr alte pdf.js-Version) bei manchen
 * strukturell validen, komprimierten pdfkit-PDFs `bad XRef entry`.
 */
import { DEFAULT_BRANDING_SETTINGS } from "@/domain/settings/branding";
import { DEFAULT_PRINT_SETTINGS } from "@/domain/settings/print";
import type { PdfTheme } from "@/lib/pdf/theme";

export function testPdfTheme(overrides: Partial<PdfTheme> = {}): PdfTheme {
  return {
    brand: structuredClone(DEFAULT_BRANDING_SETTINGS),
    options: structuredClone(DEFAULT_PRINT_SETTINGS),
    showPaymentTermsText: true,
    compress: false,
    ...overrides,
  };
}
