import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractPdfInvoiceXml } from "@/domain/incoming/pdf-attachments";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import type { EInvoiceData } from "@/lib/einvoice/types";
import { testPdfTheme } from "../helpers/pdf-theme";
import { deflateSync } from "node:zlib";
import { runIsolated, workerScriptPath } from "@/lib/worker/isolated";
import { MAX_PDF_ATTACHMENT_BYTES, MAX_PDF_ATTACHMENTS, MAX_PDF_CANDIDATES, MAX_PDF_TOTAL_BYTES } from "@/domain/incoming/limits";
import { normalizeAttachmentName } from "@/domain/incoming/pdf-attachments";
import {
  embeddedStream,
  pdfWithAttachmentBomb,
  pdfWithAttachments,
  pdfWithEmbeddedObjects,
  pdfWithManyMarkers,
  pdfWithObjectStreamBomb,
  truncate,
  zeroDeflate,
} from "../helpers/pdf-craft";

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

  it("begrenzt die Summe entpackter Bytes ueber viele Anlagen", async () => {
    const part = embeddedStream(zeroDeflate(10 * 1024 * 1024, 0x3c), "/Filter /FlateDecode");
    const pdf = pdfWithEmbeddedObjects([part, part, part, part]);
    expect(await extractPdfInvoiceXml(pdf)).toEqual({ status: "UNREADABLE", reason: "TOO_LARGE" });
    expect(MAX_PDF_TOTAL_BYTES).toBeLessThan(4 * 10 * 1024 * 1024);
  });

  it("entpackt Nicht-XML-Anlagen gar nicht", async () => {
    const pdf = pdfWithEmbeddedObjects([embeddedStream(zeroDeflate(64 * 1024 * 1024), "/Filter /FlateDecode")]);
    const res = await runIsolated<Uint8Array, { attachments: unknown[]; stats: { inflateCalls: number; inflatedBytes: number } }>({
      job: "pdf-attachments",
      input: Uint8Array.from(pdf),
      params: { maxAttachments: MAX_PDF_ATTACHMENTS, maxAttachmentBytes: MAX_PDF_ATTACHMENT_BYTES, maxTotalBytes: MAX_PDF_TOTAL_BYTES, maxCandidates: MAX_PDF_CANDIDATES },
      timeoutMs: 10_000,
      maxHeapMb: 192,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.stats).toEqual({ inflateCalls: 0, inflatedBytes: 0 });
  });

  it("entpackt Objektstroeme nie (Zaehler bleibt 0)", async () => {
    const res = await runIsolated<Uint8Array, { attachments: unknown[]; stats: { inflateCalls: number; inflatedBytes: number } }>({
      job: "pdf-attachments",
      input: Uint8Array.from(pdfWithObjectStreamBomb(256 * 1024 * 1024)),
      params: { maxAttachments: MAX_PDF_ATTACHMENTS, maxAttachmentBytes: MAX_PDF_ATTACHMENT_BYTES, maxTotalBytes: MAX_PDF_TOTAL_BYTES, maxCandidates: MAX_PDF_CANDIDATES },
      timeoutMs: 10_000,
      maxHeapMb: 192,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.attachments).toEqual([]);
      expect(res.value.stats).toEqual({ inflateCalls: 0, inflatedBytes: 0 });
    }
  });

  it("bleibt bei 100.000 /EmbeddedFile-Zeichenketten im Zeitlimit", async () => {
    const t0 = Date.now();
    expect(await extractPdfInvoiceXml(pdfWithManyMarkers(100_000))).toEqual({ status: "UNREADABLE", reason: "TOO_MANY" });
    expect(await extractPdfInvoiceXml(pdfWithManyMarkers(100_000, "/EmbeddedFiles "))).toEqual({ status: "NO_INVOICE_XML", attachments: 0 });
    expect(await extractPdfInvoiceXml(pdfWithManyMarkers(200_000, "1 "))).toEqual({ status: "NO_INVOICE_XML", attachments: 0 });
    expect(Date.now() - t0).toBeLessThan(8_000);
  });

  it("liest die Anlage trotz gefaelschter /Length", async () => {
    for (const fake of [999_999_999, 3, "7 0 R"]) {
      const r = await extractPdfInvoiceXml(pdfWithEmbeddedObjects([embeddedStream(cii, "", fake)]));
      expect(r.status).toBe("XML_FOUND");
      if (r.status === "XML_FOUND") expect(Buffer.from(r.xml).equals(cii)).toBe(true);
    }
  });

  it("ueberspringt Anlagen mit anderen Filtern", async () => {
    const hex = Buffer.from(cii.toString("hex") + ">");
    const r = await extractPdfInvoiceXml(pdfWithEmbeddedObjects([embeddedStream(hex, "/Filter /ASCIIHexDecode")]));
    expect(r).toEqual({ status: "NO_INVOICE_XML", attachments: 1, skipped: 1 });
  });

  it("nimmt bei einem inkrementellen Update die neuere Fassung", async () => {
    const v2 = Buffer.concat([cii, Buffer.from("\n")]);
    const pdf = pdfWithEmbeddedObjects([embeddedStream(cii), Buffer.from("<< /Type /Annots >>")]);
    const update = Buffer.concat([pdf, Buffer.from("5 0 obj\n"), embeddedStream(v2), Buffer.from("\nendobj\ntrailer\n<< /Size 9 /Root 1 0 R /Prev 0 >>\nstartxref\n0\n%%EOF\n")]);
    const r = await extractPdfInvoiceXml(update);
    expect(r.status).toBe("XML_FOUND");
    if (r.status === "XML_FOUND") expect(Buffer.from(r.xml).equals(v2)).toBe(true);
  });

  it("verwirft nur die defekte Nebenanlage und liest die heile Haupt-XML", async () => {
    const broken = embeddedStream(Buffer.from("das ist kein flate"), "/Filter /FlateDecode");
    const good = embeddedStream(deflateSync(cii), "/Filter /FlateDecode");
    const r = await extractPdfInvoiceXml(pdfWithEmbeddedObjects([broken, good]));
    expect(r.status).toBe("XML_FOUND");
    if (r.status === "XML_FOUND") expect(Buffer.from(r.xml).equals(cii)).toBe(true);
  });

  it("weist zu grosse Eingaben ab und kopiert die Eingabe", async () => {
    expect(await extractPdfInvoiceXml(new Uint8Array(16 * 1024 * 1024))).toEqual({ status: "UNREADABLE", reason: "TOO_LARGE" });
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: cii }]);
    const view = new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
    expect((await extractPdfInvoiceXml(view)).status).toBe("XML_FOUND");
  });

  it("begrenzt die Warteschlange", async () => {
    const pdf = await pdfWithAttachments([{ name: "factur-x.xml", bytes: cii }]);
    const results = await Promise.all(Array.from({ length: 12 }, () => extractPdfInvoiceXml(pdf)));
    expect(results.some((r) => r.status === "UNREADABLE" && r.reason === "BUSY")).toBe(true);
    expect(results.some((r) => r.status === "XML_FOUND")).toBe(true);
  });

  it("normalisiert Dateinamen", () => {
    expect(normalizeAttachmentName("../../etc/passwd.xml")).toBe("passwd.xml");
    expect(normalizeAttachmentName("C:\\tmp\\a.xml")).toBe("a.xml");
    expect(normalizeAttachmentName("a\u0000b\n.xml")).toBe("ab.xml");
    expect(normalizeAttachmentName("x".repeat(400))?.length).toBe(255);
    expect(normalizeAttachmentName("///")).toBeNull();
    expect(normalizeAttachmentName(null)).toBeNull();
  });

  it("liefert den Worker-Pfad aus dem Arbeitsverzeichnis", () => {
    expect(workerScriptPath().endsWith("incoming-worker.mjs")).toBe(true);
  });
});
