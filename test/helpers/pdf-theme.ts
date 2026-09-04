/**
 * Test-Hilfe (Phase 7, Task 3): ein `PdfTheme` mit reinen Defaults (Briefpapier +
 * Druckoptionen), ohne Logo/Hintergrund-Datei — für PDF-Renderer-Tests, die kein
 * eigenes Theme brauchen. `structuredClone`, damit kein Test versehentlich die
 * gemeinsame Default-Instanz mutiert.
 */
import { DEFAULT_BRANDING_SETTINGS } from "@/domain/settings/branding";
import { DEFAULT_PRINT_SETTINGS } from "@/domain/settings/print";
import type { PdfTheme } from "@/lib/pdf/theme";

export function testPdfTheme(overrides: Partial<PdfTheme> = {}): PdfTheme {
  return {
    brand: structuredClone(DEFAULT_BRANDING_SETTINGS),
    options: structuredClone(DEFAULT_PRINT_SETTINGS),
    ...overrides,
  };
}
