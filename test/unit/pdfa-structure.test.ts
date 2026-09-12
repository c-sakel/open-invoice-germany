/**
 * Java-freier Struktur-Test fuer PDF/A-3b (Task 6, Spec R10) — schnelle Rueckmeldung ohne
 * veraPDF (das laeuft nur in CI, siehe Task 7). Reine Bytesuche im erzeugten ZUGFeRD-PDF:
 * pdfkit schreibt Objekt-Dictionaries und die XMP-Metadaten IMMER unkomprimiert
 * (`metadataRef.compress = false` in pdfkit.js), nur Seiteninhalts-Streams werden
 * Flate-komprimiert — die hier geprueften Marker liegen alle ausserhalb davon.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { testPdfTheme } from "../helpers/pdf-theme";
import type { EInvoiceData } from "@/lib/einvoice/types";

const data: EInvoiceData = {
  number: "RE-2026-0042",
  type: "INVOICE",
  issueDate: new Date("2026-06-09"),
  dueDate: new Date("2026-06-23"),
  deliveryDate: new Date("2026-06-01"),
  currency: "EUR",
  paymentTerms: "Zahlbar innerhalb von 14 Tagen ohne Abzug.",
  seller: {
    name: "Test GmbH",
    addressLine1: "Hauptstr. 1",
    postalCode: "21339",
    city: "Lüneburg",
    countryCode: "DE",
    vatId: "DE123456789",
  },
  buyer: {
    name: "Kunde AG",
    addressLine1: "Marktplatz 2",
    postalCode: "20095",
    city: "Hamburg",
    countryCode: "DE",
  },
  lines: [{ id: "1", description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, lineNetCents: 20000, taxRate: 19, taxCategory: "S" }],
  taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: 20000, taxCents: 3800 }],
  netTotalCents: 20000,
  taxTotalCents: 3800,
  grossTotalCents: 23800,
  payableCents: 23800,
};

describe("PDF/A-3b-Struktur (ZUGFeRD-Hybrid)", () => {
  let pdfText: string;

  beforeAll(async () => {
    const pdf = await renderZugferdPdf(data, testPdfTheme());
    // Objekt-Dictionaries/XMP sind unkomprimiert (siehe Kommentar oben) — latin1 erhaelt
    // jedes Byte 1:1 als Codepunkt, ausreichend fuer reine ASCII-Marker-Suche.
    pdfText = pdf.toString("latin1");
  });

  it("traegt einen sRGB-OutputIntent", () => {
    expect(pdfText).toContain("/OutputIntents");
    expect(pdfText).toContain("/S /GTS_PDFA1");
  });

  it("XMP nennt PDF/A-3, Konformitaetsstufe B", () => {
    expect(pdfText).toMatch(/<pdfaid:part>3<\/pdfaid:part>/);
    expect(pdfText).toMatch(/<pdfaid:conformance>B<\/pdfaid:conformance>/);
  });

  it("bettet factur-x.xml als Alternative-Anhang ein (/AF, /AFRelationship)", () => {
    expect(pdfText).toContain("/AFRelationship /Alternative");
    expect(pdfText).toMatch(/\/AF \[?\d+ 0 R/);
    expect(pdfText).toContain("/Subtype /text#2Fxml");
  });

  it("traegt das Factur-X-XMP-Erweiterungsschema", () => {
    expect(pdfText).toContain("fx:DocumentFileName>factur-x.xml<");
    expect(pdfText).toContain("fx:DocumentType>INVOICE<");
    expect(pdfText).toContain("fx:ConformanceLevel>EN 16931<");
    expect(pdfText).toContain("pdfaSchema:prefix>fx<");
  });

  it("keine nicht eingebettete Standard-Helvetica (/BaseFont /Helvetica ohne Subset-Praefix)", () => {
    // Ein eingebetteter, subset-gefuehrter TrueType traegt IMMER ein 6-stelliges
    // Grossbuchstaben-Praefix + "+" vor dem PostScript-Namen (ISO 32000-1, 9.6.4).
    // Plain "/BaseFont /Helvetica" (kein Praefix) waere ein Ruemckfall auf pdfkits
    // eingebaute, nicht eingebettete AFM-Schrift und wuerde PDF/A brechen.
    expect(pdfText).not.toMatch(/\/BaseFont \/Helvetica(?:[^-]|$)/);
    expect(pdfText).not.toMatch(/\/BaseFont \/Helvetica-Bold\b/);
    // Stattdessen: eingebetteter Liberation-Sans-Font mit Subset-Praefix.
    expect(pdfText).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans/);
  });
});
