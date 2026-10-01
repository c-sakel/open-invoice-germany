/**
 * fix/ausland-land-steuerhinweis (A1) — Landeszeile in der Empfaengeranschrift: bei Empfaengern
 * im Ausland (Land != Absenderland) steht der Landesname deutsch in Grossbuchstaben als letzte
 * Anschriftszeile (Rechnung, Lieferschein inkl. Lieferanschrift, Mahnung — alle 7 Layouts);
 * im Inland nicht.
 */
import { describe, it, expect } from "vitest";
import { countryNameDe, foreignCountryLine } from "@/lib/countries";
import { senderLineFallback } from "@/lib/pdf/layout";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";

const LAYOUTS = ["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"] as const;

describe("countries.ts", () => {
  it("liefert deutsche Landesnamen in Grossbuchstaben nur fuer Auslandsanschriften", () => {
    expect(countryNameDe("AU")).toBe("Australien");
    expect(foreignCountryLine("AU", "DE")).toBe("AUSTRALIEN");
    expect(foreignCountryLine("AT", "DE")).toBe("ÖSTERREICH");
    expect(foreignCountryLine("CH", "DE")).toBe("SCHWEIZ");
    expect(foreignCountryLine("US", "DE")).toBe("VEREINIGTE STAATEN");
    expect(foreignCountryLine("de", "DE")).toBeNull();
    expect(foreignCountryLine("DE", "DE")).toBeNull();
    expect(foreignCountryLine("", "DE")).toBeNull();
    expect(foreignCountryLine(undefined, "DE")).toBeNull();
    expect(foreignCountryLine("XX1", "DE")).toBeNull();
    // Absenderland ungleich DE: DE-Empfaenger bekommt die Landeszeile, gleiches Land nicht.
    expect(foreignCountryLine("DE", "AT")).toBe("DEUTSCHLAND");
    expect(foreignCountryLine("AT", "AT")).toBeNull();
  });

  it("Absenderzeile: Absenderland nur bei Auslandsempfaenger", () => {
    const seller = { name: "Muster GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Berlin", countryCode: "DE" };
    expect(senderLineFallback(seller, "DE")).toBe("Muster GmbH · Weg 1 · 12345 Berlin");
    expect(senderLineFallback(seller, "AU")).toBe("Muster GmbH · Weg 1 · 12345 Berlin · DEUTSCHLAND");
  });
});

describe("PDF-Anschrift mit Land", () => {
  it.each(LAYOUTS)("%s: Rechnung AU/AT/CH mit Landeszeile, DE ohne", async (id) => {
    for (const [code, expected] of [["AU", "AUSTRALIEN"], ["AT", "ÖSTERREICH"], ["CH", "SCHWEIZ"]] as const) {
      const data = referenzInvoice();
      data.buyer = { ...data.buyer, countryCode: code };
      const { text } = await parsePdf(await renderInvoicePdf(data, referenzTheme({ layoutId: id })));
      expect(text, `${id} ${code}`).toContain(expected);
    }
    const de = await parsePdf(await renderInvoicePdf(referenzInvoice(), referenzTheme({ layoutId: id })));
    expect(de.text).not.toMatch(/DEUTSCHLAND|AUSTRALIEN|ÖSTERREICH|SCHWEIZ/);
  });

  it.each(LAYOUTS)("%s: Lieferschein mit Landeszeile (Empfaenger und Lieferadresse)", async (id) => {
    const data = sampleDeliveryNote();
    data.buyer = { ...data.buyer, countryCode: "AU" };
    data.seller = { ...data.seller, countryCode: "DE" };
    data.showDeliveryAddress = true;
    data.deliveryAddress = { addressLine1: "Hafenweg 3", postalCode: "8000", city: "Zuerich", countryCode: "CH" };
    const { text } = await parsePdf(await renderDeliveryNotePdf(data, testPdfTheme({ layoutId: id })));
    expect(text).toContain("AUSTRALIEN");
    expect(text).toContain("SCHWEIZ");
    const de = sampleDeliveryNote();
    de.buyer = { ...de.buyer, countryCode: "DE" };
    const inland = await parsePdf(await renderDeliveryNotePdf(de, testPdfTheme({ layoutId: id })));
    expect(inland.text).not.toMatch(/DEUTSCHLAND|AUSTRALIEN/);
  });

  it.each(LAYOUTS)("%s: Mahnung mit Landeszeile", async (id) => {
    const data = sampleDunning();
    data.buyer = { ...data.buyer, countryCode: "AT" };
    data.seller = { ...data.seller, countryCode: "DE" };
    const { text } = await parsePdf(await renderDunningPdf(data, testPdfTheme({ layoutId: id })));
    expect(text).toContain("ÖSTERREICH");
    const de = sampleDunning();
    de.buyer = { ...de.buyer, countryCode: "DE" };
    const inland = await parsePdf(await renderDunningPdf(de, testPdfTheme({ layoutId: id })));
    expect(inland.text).not.toMatch(/DEUTSCHLAND|ÖSTERREICH/);
  });
});
