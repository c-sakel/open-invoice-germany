/**
 * Phase 18f Fix-Welle 1: Leistungszeitraum je Position erscheint auch in Layouts ohne Beschreibungsspalte,
 * nur fuer Zeilen mit Zeitraum.
 */
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { parsePdf } from "../helpers/pdf-theme";

function themeWith(showDescription: boolean) {
  const t = referenzTheme({ layoutId: "standard" });
  return { ...t, options: { ...t.options, showDescription } };
}

describe("PDF: Leistungszeitraum je Position", () => {
  for (const showDescription of [true, false]) {
    it(`showDescription=${showDescription}: genau eine Zeile mit Zeitraum zeigt ihn`, async () => {
      const inv = referenzInvoice();
      const lines = inv.lines.map((l, i) => (i === 0 ? { ...l, servicePeriodStart: new Date("2186-03-01T12:00:00Z"), servicePeriodEnd: new Date("2186-03-31T12:00:00Z") } : l));
      const pdf = await renderInvoicePdf({ ...inv, lines }, themeWith(showDescription));
      const text = (await parsePdf(pdf)).text;
      expect(text.match(/Leistungszeitraum: 01\.03\.2186 – 31\.03\.2186/g)).toHaveLength(1);
      const without = (await parsePdf(await renderInvoicePdf(inv, themeWith(showDescription)))).text;
      expect(without).not.toContain("Leistungszeitraum:");
    });
  }
});
