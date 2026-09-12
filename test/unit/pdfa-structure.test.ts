/**
 * Java-freier Struktur-Test fuer PDF/A-3b (Task 6, Spec R10) — schnelle Rueckmeldung ohne
 * veraPDF (das laeuft nur in CI, siehe Task 7). Reine Bytesuche im erzeugten ZUGFeRD-PDF:
 * pdfkit schreibt Objekt-Dictionaries und die XMP-Metadaten IMMER unkomprimiert
 * (`metadataRef.compress = false` in pdfkit.js), nur Seiteninhalts-Streams werden
 * Flate-komprimiert — die hier geprueften Marker liegen alle ausserhalb davon.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { renderZugferdPdf } from "@/lib/einvoice/zugferd";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { testPdfTheme } from "../helpers/pdf-theme";
import type { EInvoiceData } from "@/lib/einvoice/types";
import type { DeliveryNotePdfData } from "@/lib/pdf/delivery-note-pdf";
import type { DunningPdfData } from "@/lib/pdf/dunning-pdf";

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

// Fix (Review Task 6/7, "must"): das ZUGFeRD-Muster oben nutzt ausschliesslich Layout
// "standard" — kursive ("Helvetica-Oblique") und fett-kursive ("Helvetica-BoldOblique")
// Schriftschnitte kommen im gesamten Bestand NUR in Layout "schlicht" vor (siehe
// src/lib/pdf/layouts/schlicht.ts, Infoblock-Belegnummer bzw. Titelzeile). Ohne dieses
// Muster war die vollstaendige Schrifteinbettung (Task 6, Spec R10) fuer zwei der vier
// Liberation-Sans-Schnitte NIE tatsaechlich geprueft — weder hier noch im veraPDF-Lauf
// (scripts/render-pdfa-samples.ts).
describe("PDF/A-3b-Struktur (Layout \"schlicht\" — kursive/fett-kursive Schnitte)", () => {
  let schlichtText: string;

  beforeAll(async () => {
    const pdf = await renderZugferdPdf(data, testPdfTheme({ layoutId: "schlicht" }));
    schlichtText = pdf.toString("latin1");
  });

  it("traegt PDF/A-Kennzeichnung auch mit Layout \"schlicht\"", () => {
    expect(schlichtText).toContain("/OutputIntents");
    expect(schlichtText).toMatch(/<pdfaid:part>3<\/pdfaid:part>/);
    expect(schlichtText).toMatch(/<pdfaid:conformance>B<\/pdfaid:conformance>/);
  });

  it("bettet den kursiven und den fett-kursiven Liberation-Sans-Schnitt ein, kein Fallback auf System-Helvetica", () => {
    expect(schlichtText).not.toMatch(/\/BaseFont \/Helvetica-Oblique\b/);
    expect(schlichtText).not.toMatch(/\/BaseFont \/Helvetica-BoldOblique\b/);
    expect(schlichtText).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans-Italic\b/);
    expect(schlichtText).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans-BoldItalic\b/);
  });
});

const deliveryNoteData: DeliveryNotePdfData = {
  number: "LS-2026-0001",
  issueDate: new Date("2026-06-01"),
  deliveryDate: new Date("2026-06-01"),
  shippingDate: null,
  currency: "EUR",
  seller: { name: "Test GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg" },
  buyer: { name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg" },
  lines: [{ pos: 1, description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19 }],
  showPrices: true,
  showTax: true,
  showArticleNumber: false,
  showDescription: true,
  showDeliveryAddress: false,
  headerText: null,
  footerText: null,
  sourceNumber: null,
};

// Guenstig mitgenommen (Review Task 6/7): bisher deckte dieser Struktur-Test nur die
// ZUGFeRD-Rechnung ab — Lieferschein und Mahnung laufen zwar durch dieselbe
// `createPdfDocument`/`registerPdfFonts`-Fabrik, wurden aber nie Java-frei auf PDF/A-
// Kennzeichnung und Schrifteinbettung geprueft (nur im veraPDF-CI-Lauf, ohne
// Schnellrueckmeldung lokal).
describe("PDF/A-3b-Struktur (Lieferschein)", () => {
  let pdfText: string;

  beforeAll(async () => {
    const pdf = await renderDeliveryNotePdf(deliveryNoteData, testPdfTheme());
    pdfText = pdf.toString("latin1");
  });

  it("traegt einen sRGB-OutputIntent und PDF/A-3-Konformitaetsstufe B", () => {
    expect(pdfText).toContain("/OutputIntents");
    expect(pdfText).toContain("/S /GTS_PDFA1");
    expect(pdfText).toMatch(/<pdfaid:part>3<\/pdfaid:part>/);
    expect(pdfText).toMatch(/<pdfaid:conformance>B<\/pdfaid:conformance>/);
  });

  it("keine nicht eingebettete Standard-Helvetica", () => {
    expect(pdfText).not.toMatch(/\/BaseFont \/Helvetica(?:[^-]|$)/);
    expect(pdfText).not.toMatch(/\/BaseFont \/Helvetica-Bold\b/);
    expect(pdfText).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans/);
  });
});

const dunningData: DunningPdfData = {
  number: "MA-2026-0001",
  level: 1,
  stageName: null,
  sentDate: new Date("2026-06-09"),
  newDueDate: new Date("2026-06-23"),
  currency: "EUR",
  seller: { name: "Test GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg" },
  buyer: { name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg" },
  invoiceNumber: "RE-2026-0042",
  invoiceDate: new Date("2026-05-01"),
  openAmountCents: 23800,
  interestCents: 123,
  flatFee40Cents: 4000,
  feeCents: 0,
  lateFeeCents: 0,
  totalCents: 23800 + 123 + 4000,
  daysOverdue: 14,
};

describe("PDF/A-3b-Struktur (Mahnung)", () => {
  let pdfText: string;

  beforeAll(async () => {
    const pdf = await renderDunningPdf(dunningData, testPdfTheme());
    pdfText = pdf.toString("latin1");
  });

  it("traegt einen sRGB-OutputIntent und PDF/A-3-Konformitaetsstufe B", () => {
    expect(pdfText).toContain("/OutputIntents");
    expect(pdfText).toContain("/S /GTS_PDFA1");
    expect(pdfText).toMatch(/<pdfaid:part>3<\/pdfaid:part>/);
    expect(pdfText).toMatch(/<pdfaid:conformance>B<\/pdfaid:conformance>/);
  });

  it("keine nicht eingebettete Standard-Helvetica", () => {
    expect(pdfText).not.toMatch(/\/BaseFont \/Helvetica(?:[^-]|$)/);
    expect(pdfText).not.toMatch(/\/BaseFont \/Helvetica-Bold\b/);
    expect(pdfText).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans/);
  });
});
