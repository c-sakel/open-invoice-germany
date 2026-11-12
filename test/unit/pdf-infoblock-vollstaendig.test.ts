/** Pflichtangaben im Infoblock (Nummer, Datum, Kundennummer) werden bei engem Platz umbrochen, nie gekuerzt. */
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { LAYOUT_IDS } from "@/lib/pdf/layouts/ids";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import type { PdfTheme } from "@/lib/pdf/theme";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";
import { parsePdf } from "../helpers/pdf-theme";

function narrow(theme: PdfTheme): PdfTheme {
  theme.brand.marginRightMm = 40;
  return theme;
}

const compact = (t: string): string => t.replace(/\s+/g, "");

describe("Infoblock bei rechtem Rand 40 mm: vollstaendig, nie gekuerzt", () => {
  const variants: { name: string; theme: () => PdfTheme }[] = [
    ...LAYOUT_IDS.map((id) => ({ name: id, theme: () => narrow(referenzTheme({ compress: false, layoutId: id })) })),
    { name: "design", theme: () => narrow(referenzTheme({ compress: false, layoutConfig: presetConfig("standard") })) },
  ];
  for (const v of variants) {
    it(`${v.name}: Rechnung, Angebot, Lieferschein, Mahnung`, async () => {
      const inv = referenzInvoice();
      for (const data of [inv, { ...inv, type: "ANGEBOT" as const, number: "AN-2073-00007" }]) {
        const { text } = await parsePdf(await renderInvoicePdf(data, v.theme()));
        const t = compact(text);
        expect(t).toContain(data.number);
        expect(t).toContain("30.09.2073");
        expect(t).toContain("KD-00002");
        expect(t).not.toContain("…");
      }
      const dn = sampleDeliveryNote();
      const d = compact((await parsePdf(await renderDeliveryNotePdf(dn, v.theme()))).text);
      expect(d).toContain(dn.number);
      expect(d).not.toContain("…");
      const du = sampleDunning();
      const m = compact((await parsePdf(await renderDunningPdf(du, v.theme()))).text);
      expect(m).toContain(compact(du.number));
      expect(m).not.toContain("…");
    });
  }
});
