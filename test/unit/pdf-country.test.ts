/**
 * fix/ausland-land-steuerhinweis (A1) + fix/land-immer (Betreiber 2026-10-09) — Landeszeile in
 * der Empfaengeranschrift: der Landesname steht deutsch in Grossbuchstaben als letzte
 * Anschriftszeile, IMMER (auch Inland), ebenso das Absenderland in der Absenderzeile und der
 * Landesname der Firma in der Fusszeile (Rechnung, Lieferschein inkl. Lieferanschrift,
 * Mahnung — alle 7 Layouts).
 */
import { describe, it, expect } from "vitest";
import { countryNameDe, addressCountryLine } from "@/lib/countries";
import { senderLineFallback } from "@/lib/pdf/layout";
import { buildFooterColumns } from "@/lib/pdf/footer";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";

const LAYOUTS = ["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"] as const;

describe("countries.ts", () => {
  it("liefert deutsche Landesnamen in Grossbuchstaben fuer jede Anschrift, auch Inland", () => {
    expect(countryNameDe("AU")).toBe("Australien");
    expect(addressCountryLine("AU")).toBe("AUSTRALIEN");
    expect(addressCountryLine("AT")).toBe("ÖSTERREICH");
    expect(addressCountryLine("CH")).toBe("SCHWEIZ");
    expect(addressCountryLine("US")).toBe("VEREINIGTE STAATEN");
    expect(addressCountryLine("de")).toBe("DEUTSCHLAND");
    expect(addressCountryLine("DE")).toBe("DEUTSCHLAND");
    expect(addressCountryLine("")).toBeNull();
    expect(addressCountryLine(undefined)).toBeNull();
    expect(addressCountryLine("XX1")).toBeNull();
  });

  it("Absenderzeile: Absenderland immer", () => {
    const seller = { name: "Muster GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Berlin", countryCode: "DE" };
    expect(senderLineFallback(seller)).toBe("Muster GmbH · Weg 1 · 12345 Berlin · DEUTSCHLAND");
    expect(senderLineFallback({ ...seller, countryCode: null })).toBe("Muster GmbH · Weg 1 · 12345 Berlin · DEUTSCHLAND");
  });

  it("Fusszeile: Landesname der Firma unter PLZ Ort", () => {
    const seller = { name: "Muster GmbH", addressLine1: "Weg 1", postalCode: "12345", city: "Berlin", countryCode: "AT" };
    const cols = buildFooterColumns({ seller }, { footerMode: "AUTO" } as Parameters<typeof buildFooterColumns>[1]);
    expect(cols[0].lines).toEqual(["Muster GmbH", "Weg 1", "12345 Berlin", "Österreich"]);
    const de = buildFooterColumns({ seller: { ...seller, countryCode: undefined } }, { footerMode: "AUTO" } as Parameters<typeof buildFooterColumns>[1]);
    expect(de[0].lines.at(-1)).toBe("Deutschland");
  });
});

describe("PDF-Anschrift mit Land", () => {
  it.each(LAYOUTS)("%s: Rechnung AU/AT/CH/DE mit Landeszeile", async (id) => {
    for (const [code, expected] of [["AU", "AUSTRALIEN"], ["AT", "ÖSTERREICH"], ["CH", "SCHWEIZ"]] as const) {
      const data = referenzInvoice();
      data.buyer = { ...data.buyer, countryCode: code };
      const { text } = await parsePdf(await renderInvoicePdf(data, referenzTheme({ layoutId: id })));
      expect(text, `${id} ${code}`).toContain(expected);
    }
    const de = await parsePdf(await renderInvoicePdf(referenzInvoice(), referenzTheme({ layoutId: id })));
    expect(de.text).toMatch(/\d{5} [^\n]+\nDEUTSCHLAND/);
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
    expect(inland.text).toContain("DEUTSCHLAND");
    expect(inland.text).not.toContain("AUSTRALIEN");
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
    expect(inland.text).toContain("DEUTSCHLAND");
    expect(inland.text).not.toContain("ÖSTERREICH");
  });
});
