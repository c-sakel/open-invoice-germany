import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractPdfInvoiceXml } from "@/domain/incoming/pdf-attachments";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import type { EInvoiceData } from "@/lib/einvoice/types";
import { testPdfTheme } from "../helpers/pdf-theme";
import { pdfWithAttachmentBomb, pdfWithAttachments, pdfWithObjectStreamBomb, truncate } from "../helpers/pdf-craft";

const fx = (n: string) => fs.readFileSync(path.resolve(__dirname, "../fixtures/incoming", n));
const cii = fx("gen-base-cii.xml");

const data: EInvoiceData = {
  number: "RE-2233-0001",
  type: "INVOICE",
  issueDate: new Date("2233-06-09"),
  dueDate: new Date("2233-06-23"),
  deliveryDate: new Date("2233-06-01"),
  currency: "EUR",
  seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lueneburg", countryCode: "DE", vatId: "DE123456789" },
  buyer: { name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE" },
  lines: [{ id: "1", description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, lineNetCents: 20000, taxRate: 19, taxCategory: "S" }],
  taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: 20000, taxCents: 3800 }],
  netTotalCents: 20000,
  taxTotalCents: 3800,
  grossTotalCents: 23800,
  payableCents: 23800,
};

describe("extractPdfInvoiceXml", () => {
  it("liest die eingebettete XML eines ZUGFeRD-PDFs byte-genau", async () => {
    const xml = buildFacturXCII(data);
    const pdf = await renderZugferdPdf(data, testPdfTheme(), xml);
    const r = await extractPdfInvoiceXml(pdf);
    expect(r.status).toBe("XML_FOUND");
    if (r.status === "XML_FOUND") {
      expect(Buffer.from(r.xml).equals(Buffer.from(xml, "utf8"))).toBe(true);
      expect(r.fileName).toBe("factur-x.xml");
    }
  });

  it("findet eine Anlage namens zugferd-invoice.xml", async () => {
    const r = await extractPdfInvoiceXml(await pdfWithAttachments([{ name: "ZUGFeRD-Invoice.XML", bytes: cii }]));
    expect(r.status).toBe("XML_FOUND");
    if (r.status === "XML_FOUND") expect(Buffer.from(r.xml).equals(cii)).toBe(true);
  });

  it("findet eine Anlage ohne passenden Namen anhand des Inhalts", async () => {
    const r = await extractPdfInvoiceXml(
      await pdfWithAttachments([
        { name: "notiz.xml", bytes: Buffer.from("<notiz>kein Beleg</notiz>") },
        { name: "daten.xml", bytes: cii },
      ]),
    );
    expect(r.status).toBe("XML_FOUND");
    if (r.status === "XML_FOUND") {
      expect(r.fileName).toBe("daten.xml");
      expect(r.others).toBe(1);
    }
  });

  it("meldet NO_INVOICE_XML bei einer reinen Bild-Anlage", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const r = await extractPdfInvoiceXml(await pdfWithAttachments([{ name: "logo.png", bytes: png, type: "image/png" }]));
    expect(r).toEqual({ status: "NO_INVOICE_XML", attachments: 1 });
  });

  it("meldet verschluesselte PDFs", async () => {
    const r = await extractPdfInvoiceXml(await pdfWithAttachments([{ name: "factur-x.xml", bytes: cii }], { userPassword: "geheim" }));
    expect(r).toEqual({ status: "UNREADABLE", reason: "ENCRYPTED" });
  });

  it("meldet abgeschnittene PDFs als BROKEN", async () => {
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: cii }]);
    expect(await extractPdfInvoiceXml(truncate(pdf))).toEqual({ status: "UNREADABLE", reason: "BROKEN" });
  });

  it("weist mehr als 20 Anlagen ab", async () => {
    const files = Array.from({ length: 25 }, (_, i) => ({ name: `anlage-${i}.xml`, bytes: Buffer.from(`<a>${i}</a>`) }));
    expect(await extractPdfInvoiceXml(await pdfWithAttachments(files))).toEqual({ status: "UNREADABLE", reason: "TOO_MANY" });
  });

  it("weist Dekompressionsbomben ab und bleibt im Speicherrahmen", async () => {
    const bombA = pdfWithAttachmentBomb(64 * 1024 * 1024);
    const bombO = pdfWithObjectStreamBomb(256 * 1024 * 1024);
    global.gc?.();
    const before = process.memoryUsage().rss;
    const attach = await extractPdfInvoiceXml(bombA);
    expect(attach).toEqual({ status: "UNREADABLE", reason: "TOO_LARGE" });
    // Objektstrom wird nie entpackt: keine Anlage, kein Fehler.
    const objStm = await extractPdfInvoiceXml(bombO);
    expect(["NO_INVOICE_XML", "UNREADABLE"]).toContain(objStm.status);
    expect(process.memoryUsage().rss).toBeLessThan(before + 300 * 1024 * 1024);
  });
});
