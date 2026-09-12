/**
 * Rendert drei PDF/A-3b-Beispielbelege (ZUGFeRD-Rechnung mit Logo + GiroCode, Lieferschein,
 * Mahnung) nach `tmp/pdfa-samples/` — reine Musterdaten (analog `src/domain/settings/
 * preview.ts`), **kein DB-Zugriff**. Wird in CI (`.github/workflows/ci.yml`, Job
 * `xrechnung-kosit`) vor dem veraPDF-Schritt (Task 7) aufgerufen, lokal ebenso nutzbar:
 *
 *   npx tsx scripts/render-pdfa-samples.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { buildSampleInvoiceData, buildSampleDeliveryNoteData, buildSampleDunningData } from "@/domain/settings/preview";
import { DEFAULT_BRANDING_SETTINGS } from "@/domain/settings/branding";
import { DEFAULT_PRINT_SETTINGS } from "@/domain/settings/print";
import type { PdfTheme } from "@/lib/pdf/theme";

const OUT_DIR = path.join(process.cwd(), "tmp/pdfa-samples");

/** Musterorganisation mit IBAN/BIC (fuer den GiroCode) — kein DB-Zugriff, siehe
 *  `PreviewOrg` in `src/domain/settings/preview.ts`. */
const SAMPLE_ORG = {
  legalName: "Muster GmbH",
  addressLine1: "Hauptstr. 1",
  addressLine2: null,
  postalCode: "21339",
  city: "Lüneburg",
  country: "DE",
  vatId: "DE123456789",
  taxNumber: null,
  email: "info@muster.example",
  phone: "+49 4131 100",
  electronicAddress: null,
  iban: "DE02120300000000202051",
  bic: "BYLADEM1001",
  bankName: "Musterbank",
  accountHolder: "Muster GmbH",
};

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Minimales, selbst erzeugtes RGB-PNG (Farbtyp 2, 8 bit, KEIN CMYK — siehe Spec R11) als
 * Muster-Logo. Kein committetes Binaerfixture noetig, pdfkit (png.js) liest Farbtyp 2 direkt.
 */
function samplePngLogo(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 2; // Farbtyp 2 = Truecolour (RGB)
  const stride = 1 + width * 3; // je Zeile ein Filter-Byte 0 ("None")
  const raw = Buffer.alloc(height * stride, 0x4a); // einfarbig dunkelgrau, reicht als Logo-Platzhalter
  for (let y = 0; y < height; y++) raw[y * stride] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function baseTheme(): PdfTheme {
  return {
    brand: { ...structuredClone(DEFAULT_BRANDING_SETTINGS), logoWidthMm: 30 },
    options: structuredClone(DEFAULT_PRINT_SETTINGS),
    layoutId: "standard",
    footerFacts: { website: "muster.example", ownerName: "Muster GmbH" },
    showPaymentTermsText: true,
    logoBuffer: samplePngLogo(240, 80),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const theme = baseTheme();

  const invoiceData = buildSampleInvoiceData(SAMPLE_ORG, "INVOICE");
  writeFileSync(path.join(OUT_DIR, "rechnung-zugferd.pdf"), await renderZugferdPdf(invoiceData, theme));

  writeFileSync(path.join(OUT_DIR, "lieferschein.pdf"), await renderDeliveryNotePdf(buildSampleDeliveryNoteData(SAMPLE_ORG), theme));

  writeFileSync(path.join(OUT_DIR, "mahnung.pdf"), await renderDunningPdf(buildSampleDunningData(SAMPLE_ORG), theme));

  // Fix (Review Task 6/7, "must"): die drei Muster oben nutzen alle Layout "standard" —
  // kursive ("Helvetica-Oblique") und fett-kursive ("Helvetica-BoldOblique") Schriftschnitte
  // kommen im gesamten Bestand NUR in Layout "schlicht" vor (src/lib/pdf/layouts/
  // schlicht.ts). Ohne ein Muster mit diesem Layout war die vollstaendige Schrifteinbettung
  // (Task 6, Spec R10) fuer zwei der vier Liberation-Sans-Schnitte NIE tatsaechlich durch
  // veraPDF geprueft.
  const schlichtTheme: PdfTheme = { ...baseTheme(), layoutId: "schlicht" };
  writeFileSync(path.join(OUT_DIR, "rechnung-schlicht.pdf"), await renderZugferdPdf(invoiceData, schlichtTheme));

  console.log(`PDF/A-3b-Muster erzeugt: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error((e as Error).message ?? e);
  process.exit(1);
});
