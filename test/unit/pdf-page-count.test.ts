import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { countPdfPages } from "@/lib/pdf/page-count";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { testPdfTheme, parsePdf } from "../helpers/pdf-theme";
import type { EInvoiceData } from "@/lib/einvoice/types";

function makePdf(pages: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ compress: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (let i = 0; i < pages; i += 1) {
      if (i > 0) doc.addPage();
      doc.text(`Seite ${i + 1}`);
    }
    doc.end();
  });
}

function sampleInvoice(lineCount: number): EInvoiceData {
  const lines = Array.from({ length: lineCount }, (_, i) => ({
    id: String(i + 1),
    description: `Position ${i + 1} mit etwas laengerem Text zur Beschreibung der Leistung`,
    quantityMilli: 1000,
    unit: "C62",
    unitNetPriceCents: 1000,
    lineNetCents: 1000,
    taxRate: 19,
    taxCategory: "S" as const,
    lineType: "ITEM" as const,
  }));
  const net = 1000 * lineCount;
  const tax = Math.round(net * 0.19);
  return {
    number: "RE-2123-00099",
    type: "INVOICE",
    issueDate: new Date("2123-05-02"),
    currency: "EUR",
    seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin", countryCode: "DE" },
    buyer: { name: "Kunde AG", addressLine1: "Kundenweg 2", postalCode: "54321", city: "Stadt", countryCode: "DE" },
    lines,
    taxSubtotals: [{ taxRate: 19, taxCategory: "S", netCents: net, taxCents: tax }],
    netTotalCents: net,
    taxTotalCents: tax,
    grossTotalCents: net + tax,
    payableCents: net + tax,
    giroAmountCents: 0,
    iban: null,
  };
}

describe("countPdfPages", () => {
  it.each([1, 2, 7])("pdfkit-Dokument mit %i Seiten", async (n) => {
    expect(countPdfPages(await makePdf(n))).toBe(n);
  });

  it("Rechnungs-PDF stimmt mit pdf-parse ueberein (ein- und mehrseitig)", async () => {
    for (const lines of [2, 90]) {
      const pdf = await renderInvoicePdf(sampleInvoice(lines), testPdfTheme());
      const n = countPdfPages(pdf);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBe((await parsePdf(pdf)).numpages);
    }
  });

  it("Muell -> Fehler", () => {
    expect(() => countPdfPages(Buffer.from("kein pdf"))).toThrow();
    expect(() => countPdfPages(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"))).toThrow();
  });
});
