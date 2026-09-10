/**
 * Phase 13b, Task 4 — Betreff im PDF (`drawSubject`, `layouts/shared.ts`): eigene fette
 * Zeile direkt ueber dem Kopftext, in allen sieben Layouts, ohne den byte-gleichen
 * Referenzfall (kein Betreff gesetzt) zu veraendern. Muster: pdf-theme.test.ts (Text
 * ueber pdf-parse).
 */
import { describe, it, expect, vi } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { LAYOUT_IDS } from "@/lib/pdf/layouts/ids";
import { testPdfTheme, parsePdf } from "../helpers/pdf-theme";
import type { EInvoiceData } from "@/lib/einvoice/types";

async function pdfText(pdf: Buffer): Promise<string> {
  return (await parsePdf(pdf)).text;
}

const base: EInvoiceData = {
  number: "RE-2056-00001",
  type: "INVOICE",
  issueDate: new Date("2056-03-10"),
  currency: "EUR",
  seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin", countryCode: "DE" },
  buyer: { name: "Kunde AG", addressLine1: "Kundenweg 2", postalCode: "54321", city: "Stadt", countryCode: "DE" },
  lines: [
    {
      id: "1",
      description: "Testposition",
      quantityMilli: 1000,
      unit: "C62",
      unitNetPriceCents: 1000,
      lineNetCents: 1000,
      taxRate: 19,
      taxCategory: "S",
      lineType: "ITEM",
    },
  ],
  taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: 1000, taxCents: 190 }],
  netTotalCents: 1000,
  taxTotalCents: 190,
  grossTotalCents: 1190,
  payableCents: 1190,
  iban: null,
};

const theme = testPdfTheme();

describe("PDF-Betreff (Phase 13b, Task 4)", () => {
  it("druckt den Betreff genau einmal und ueber dem Kopftext", async () => {
    const text = await pdfText(await renderInvoicePdf({ ...base, subject: "Wartung Anlage 4711", headerText: "Guten Tag," }, theme));
    expect(text.match(/Wartung Anlage 4711/g)).toHaveLength(1);
    expect(text.indexOf("Wartung Anlage 4711")).toBeLessThan(text.indexOf("Guten Tag,"));
  });

  it("ohne Betreff bleibt die Ausgabe byte-gleich zur Referenz", async () => {
    // pdfkit setzt info.CreationDate = new Date() je Render-Aufruf und hasht es in die
    // Trailer-/ID-Bytes ein (PDFSecurity.generateFileID) — ohne eingefrorene Zeit
    // unterscheiden sich zwei Aufrufe bereits durch den Millisekunden-Zeitstempel, auch
    // OHNE jede inhaltliche Aenderung. Fuer den reinen Byte-Vergleich daher `Date`
    // einfrieren (nur `Date`, keine Timer — renderInvoicePdf macht keine DB/Async-I/O).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2056-03-10T12:00:00.000Z"));
    try {
      const a = await renderInvoicePdf({ ...base, subject: null }, { ...theme, compress: false });
      const b = await renderInvoicePdf(base, { ...theme, compress: false });
      expect(a.equals(b)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Nachtrag Task 7: nur Whitespace bleibt byte-gleich zur Referenz (getrimmt)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2056-03-10T12:00:00.000Z"));
    try {
      const a = await renderInvoicePdf({ ...base, subject: "   \n\t " }, { ...theme, compress: false });
      const b = await renderInvoicePdf(base, { ...theme, compress: false });
      expect(a.equals(b)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ein 200 Zeichen langer Betreff bricht um und verdraengt den Adressblock nicht", async () => {
    const text = await pdfText(await renderInvoicePdf({ ...base, subject: "L".repeat(200) }, theme));
    expect(text).toContain(base.buyer.name);
    expect(text).toContain("Rechnungsdatum");
  });

  it("gilt fuer alle sieben Layouts", async () => {
    for (const id of LAYOUT_IDS) {
      const text = await pdfText(await renderInvoicePdf({ ...base, subject: "Betreffprobe" }, { ...theme, layoutId: id }));
      expect({ id, hit: text.includes("Betreffprobe") }).toEqual({ id, hit: true });
    }
  });
});
