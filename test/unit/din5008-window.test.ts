/** Phase 16g, Task 4 — Empfaenger, Absenderzeile und Logo bleiben im DIN-5008-Fenster. */
import { describe, it, expect } from "vitest";
import { buildLayout } from "@/lib/pdf/layouts/configurable";
import { presetConfig } from "@/lib/pdf/layouts/presets";
import { PDF_FONT_FAMILIES } from "@/lib/pdf/font-families";
import { createPdfDocument } from "@/lib/pdf/document";
import { marginsFromMm, mm } from "@/lib/pdf/layout";
import type { LayoutFrame } from "@/lib/pdf/layouts/types";
import type { LayoutDesignConfig } from "@/schemas/layout-design";
import { testPdfTheme, testPngBuffer } from "../helpers/pdf-theme";
import { recordTextBoxes, expectInDinWindow } from "../helpers/din5008";

const SENDER = "Beispiel Hosting · Musterweg 10 · 12345 Musterstadt · DEUTSCHLAND";
const RECIPIENT = {
  name: "Beispiel Automotive GmbH",
  contactName: "Frau Erika Musterfrau",
  addressLine1: "Kundenstraße 13",
  addressLine2: "Hinterhaus, 3. Etage",
  postalCode: "12345",
  city: "Musterstadt",
  countryLine: "ÖSTERREICH",
};
const MARGINS: { name: string; top: number; left: number; header: number }[] = [
  { name: "top 5/left 20", top: 5, left: 20, header: 25 },
  { name: "top 20/left 25", top: 20, left: 25, header: 25 },
];

function render(config: LayoutDesignConfig, withLogo = false) {
  const theme = testPdfTheme({ layoutConfig: config, ...(withLogo ? { logoBuffer: testPngBuffer(400, 800) } : {}) });
  const layout = buildLayout(config);
  const margins = marginsFromMm(config.marginsMm);
  const doc = createPdfDocument({ size: "A4", margins, compress: false, pdfa: true, fontFamily: config.font });
  const frame: LayoutFrame = {
    doc, theme, margins, left: margins.left, right: doc.page.width - margins.right, width: doc.page.width - margins.right - margins.left,
    primary: config.colors.primary, base: config.fontSizePt,
  };
  const rec = recordTextBoxes(doc);
  layout.drawKopf(frame, {
    title: "Rechnung", numberLabel: "Rechnungsnr.", number: "RE-2120-00001",
    meta: [{ label: "Datum", value: "30.09.2120" }, { label: "Kundennr.", value: "KD-00002" }],
    recipient: RECIPIENT, senderFallback: SENDER,
  });
  const boxes = rec.stop();
  doc.end();
  return boxes;
}

describe("DIN-5008-Fenster", () => {
  for (const font of PDF_FONT_FAMILIES) {
    for (const size of [8, 12]) {
      for (const m of MARGINS) {
        it(`${font} ${size} pt, ${m.name}: Anschrift im Fenster`, () => {
          const base = presetConfig("standard");
          const config: LayoutDesignConfig = {
            ...base, font, fontSizePt: size,
            marginsMm: { ...base.marginsMm, top: m.top, left: m.left },
            header: { heightMm: 45 - m.top },
          };
          const boxes = render(config);
          expectInDinWindow(boxes, [SENDER, RECIPIENT.name, RECIPIENT.contactName, RECIPIENT.addressLine1, RECIPIENT.addressLine2, "12345 Musterstadt", "ÖSTERREICH"]);
        });
      }
    }
  }

  it("hohes Logo bleibt in der Kopfzone", () => {
    const base = presetConfig("standard");
    const config: LayoutDesignConfig = { ...base, marginsMm: { ...base.marginsMm, top: 5 }, header: { heightMm: 40 }, logo: { position: "right", widthMm: 80 } };
    const image = render(config, true).find((b) => b.text === "[image]");
    expect(image).toBeDefined();
    expect(image!.yPt + image!.heightPt).toBeLessThanOrEqual(mm(config.marginsMm.top + config.header.heightMm) + 0.01);
  });
});
