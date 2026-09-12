/**
 * Hotfix (A1, Tiefenanalyse UI/Ausgabe/Bedienung) — Zeilenkollision im Rechnungs-PDF:
 * `invoice-pdf.ts` zeichnete ITEM-Zeilen bisher mit fester Hoehe (`rowH`), ohne die
 * Beschreibung vorher zu messen. Bricht die Beschreibung auf mehrere Zeilen um,
 * ueberdruckte die naechste Position den Text. Dieser Test rendert eine Rechnung mit
 * einer sehr langen (garantiert umbrechenden) Beschreibung in Position 1 und prueft
 * anhand der tatsaechlichen Text-Positionen im PDF (pdf.js `transform[5]` = y in
 * PDF-Koordinaten, Ursprung unten links), dass Position 2 deutlich unterhalb der letzten
 * umgebrochenen Zeile von Position 1 beginnt statt im alten, fixen `rowH`-Abstand.
 */
import { describe, it, expect } from "vitest";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { testPdfTheme } from "../helpers/pdf-theme";
import type { EInvoiceData, EInvoiceLine } from "@/lib/einvoice/types";

/** Minimale Rechnung (Testjahr 2073, wie test/unit/pdf-layouts.test.ts) mit zwei
 *  ITEM-Zeilen: Position 1 traegt eine sehr lange Beschreibung, die in der
 *  Standard-Beschreibungsspalte (Standardlayout, 18mm Raender) auf mehrere Zeilen
 *  umbricht; Position 2 traegt einen kurzen, eindeutigen Marker. */
function invoiceWithLongDescription(): EInvoiceData {
  const lines: EInvoiceLine[] = [
    {
      id: "1",
      description: "MARKERSTART " + "Sehr lange Positionsbeschreibung mit viel Text ".repeat(15),
      quantityMilli: 1000,
      unit: "C62",
      unitNetPriceCents: 1000,
      lineNetCents: 1000,
      taxRate: 19,
      taxCategory: "S",
      lineType: "ITEM",
    },
    {
      id: "2",
      description: "MARKERITEM2",
      quantityMilli: 1000,
      unit: "C62",
      unitNetPriceCents: 1000,
      lineNetCents: 1000,
      taxRate: 19,
      taxCategory: "S",
      lineType: "ITEM",
    },
  ];
  const net = 2000;
  const tax = Math.round(net * 0.19);
  return {
    number: "RE-2073-00099",
    type: "INVOICE",
    issueDate: new Date("2073-05-02"),
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

interface TextItem {
  str: string;
  y: number;
}

/** Liest alle Textobjekte (Inhalt + y-Position) des PDF ueber pdf.js' `getTextContent()`
 *  aus (eigener `pagerender`, statt der Volltext-Konkatenation des Test-Helpers). */
async function extractTextItems(pdf: Buffer): Promise<TextItem[]> {
  const collect = async (buf: Buffer): Promise<TextItem[]> => {
    const items: TextItem[] = [];
    await pdfParse(buf, {
      pagerender: (pageData: { getTextContent: () => Promise<{ items: { str: string; transform: number[] }[] }> }) =>
        pageData.getTextContent().then((content) => {
          for (const item of content.items) items.push({ str: item.str, y: item.transform[5]! });
          return "";
        }),
    });
    return items;
  };
  try {
    return await collect(pdf);
  } catch {
    // Fix-Welle (siehe test/helpers/pdf-theme.ts#parsePdf): pdf-parse (pdf.js ~2017) wirft
    // beim zweiten Aufruf im selben Prozess gelegentlich "bad XRef entry" — auch fuer
    // strukturell einwandfreie PDFs. Ein erneuter Versuch mit einer frischen Buffer-Kopie
    // behebt es zuverlaessig.
    return await collect(Buffer.from(pdf));
  }
}

describe("invoice-pdf — Hotfix A1: Zeilenkollision bei mehrzeiliger Beschreibung", () => {
  it("Position 2 ueberlappt die umgebrochene Beschreibung von Position 1 nicht", async () => {
    const pdf = await renderInvoicePdf(invoiceWithLongDescription(), testPdfTheme({ layoutId: "standard" }));
    const items = await extractTextItems(pdf);
    const start = items.find((i) => i.str.includes("MARKERSTART"));
    const item2 = items.find((i) => i.str.includes("MARKERITEM2"));
    expect(start).toBeDefined();
    expect(item2).toBeDefined();
    // Standardlayout, fontSizePt 10 (Default) -> rowH = round((10-1)*1.8) = 16 (siehe
    // invoice-pdf.ts). Beim alten Bug (feste Zeilenhoehe `h = rowH`) waere der Abstand
    // zwischen Position 1 und Position 2 GENAU `rowH`, unabhaengig vom Umbruch — die
    // Positionen ueberdruckten sich. Mit dem Hotfix waechst der Abstand mit der Anzahl der
    // tatsaechlich umgebrochenen Zeilen (hier viele) deutlich darueber hinaus.
    const rowH = 16;
    expect(start!.y - item2!.y).toBeGreaterThan(rowH * 2);
  });

  it("liefert weiterhin ein gueltiges PDF mit kurzer (einzeiliger) Beschreibung (keine Regression)", async () => {
    const data = invoiceWithLongDescription();
    data.lines[0]!.description = "Kurze Beschreibung";
    const pdf = await renderInvoicePdf(data, testPdfTheme({ layoutId: "standard" }));
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
