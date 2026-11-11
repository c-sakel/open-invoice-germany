/**
 * Test-Fixtures (Phase 11b, Task 4) fuer Lieferschein- und Mahnungs-PDFs — DB-frei
 * (anders als die gleichnamigen Fixtures in `test/integration/pdf-theme.test.ts`, die
 * eine echte Organization anlegen; deren eigene Kopien bleiben dort unveraendert stehen).
 * Testjahr 2073 (wie `sampleInvoice()` in `test/unit/pdf-layouts.test.ts`).
 */
import { inflateSync } from "node:zlib";
import type { DeliveryNotePdfData } from "@/lib/pdf/delivery-note-pdf";
import type { DunningPdfData } from "@/lib/pdf/dunning-pdf";

export function sampleDeliveryNote(): DeliveryNotePdfData {
  return {
    number: "LS-2073-00001",
    issueDate: new Date("2073-05-02"),
    deliveryDate: new Date("2073-05-03"),
    currency: "EUR",
    seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin" },
    buyer: { name: "Kunde AG", contactName: "Frau Beispiel", addressLine1: "Kundenweg 2", postalCode: "54321", city: "Stadt" },
    lines: [
      { pos: 1, description: "Testartikel A", quantityMilli: 2000, unit: "C62" },
      { pos: 2, description: "Testartikel B", quantityMilli: 1000, unit: "C62" },
    ],
    showPrices: false,
    showTax: false,
    showArticleNumber: false,
    showDescription: true,
    showDeliveryAddress: false,
  };
}

export function sampleDunning(): DunningPdfData {
  return {
    number: "M-2073-00001",
    level: 1,
    sentDate: new Date("2073-05-01"),
    newDueDate: new Date("2073-05-15"),
    currency: "EUR",
    seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin" },
    buyer: { name: "Kunde AG", addressLine1: "Kundenweg 2", postalCode: "54321", city: "Stadt" },
    invoiceNumber: "RE-2073-00001",
    invoiceDate: new Date("2073-03-10"),
    openAmountCents: 11900,
    interestCents: 100,
    flatFee40Cents: 4000,
    feeCents: 0,
    lateFeeCents: 4100,
    totalCents: 16000,
    daysOverdue: 20,
  };
}

/**
 * Phase 16a: liest den Inhalt eines eingebetteten Datei-Anhangs (`/Type /EmbeddedFile`) aus
 * einem pdfkit-PDF — nimmt den ersten EmbeddedFile-Stream, entpackt ihn bei `/FlateDecode`.
 * Reicht fuer die Rechnungs-PDFs, die genau einen Anhang (factur-x.xml) tragen.
 */
export function extractFirstEmbeddedFile(pdf: Buffer): Buffer {
  const text = pdf.toString("latin1");
  const typeAt = text.indexOf("/Type /EmbeddedFile");
  if (typeAt < 0) throw new Error("Kein EmbeddedFile im PDF.");
  const objStart = text.lastIndexOf(" obj", typeAt);
  const streamKw = text.indexOf("stream", typeAt);
  const dict = text.slice(objStart, streamKw);
  let dataStart = streamKw + "stream".length;
  if (text[dataStart] === "\r") dataStart += 1;
  if (text[dataStart] === "\n") dataStart += 1;
  const length = /\/Length (\d+)/.exec(dict);
  if (!length) throw new Error("EmbeddedFile ohne /Length.");
  const raw = pdf.subarray(dataStart, dataStart + Number(length[1]));
  return dict.includes("/FlateDecode") ? inflateSync(raw) : Buffer.from(raw);
}
