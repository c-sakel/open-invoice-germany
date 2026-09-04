/**
 * Phase 7, Task 3 (§35-§37) — PdfTheme-Pipeline (loadPdfTheme + Renderer). Testjahr 2056
 * (siehe plan-header.md).
 */
import { describe, it, expect } from "vitest";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { dbInternal } from "@/lib/db";
import { loadPdfTheme } from "@/domain/settings/theme";
import { savePrintSettings } from "@/domain/settings/print";
import { saveDocumentSettings } from "@/domain/document/settings";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf, type DeliveryNotePdfData } from "@/lib/pdf/delivery-note-pdf";
import type { EInvoiceData, EInvoiceLine } from "@/lib/einvoice/types";

async function makeOrg(overrides: Partial<{ iban: string | null }> = {}) {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Pdf-Theme Test GmbH",
      addressLine1: "Teststr. 1",
      postalCode: "12345",
      city: "Berlin",
      iban: overrides.iban ?? "DE02120300000000202051",
      bic: "INGDDEFFXXX",
      bankName: "Testbank",
    },
  });
  return org.id;
}

function manyLines(count: number): EInvoiceLine[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    description: `Testposition ${i + 1}`,
    quantityMilli: 1000,
    unit: "C62",
    unitNetPriceCents: 1000,
    lineNetCents: 1000,
    taxRate: 19,
    taxCategory: "S",
    lineType: "ITEM" as const,
  }));
}

function baseInvoiceData(overrides: Partial<EInvoiceData> = {}): EInvoiceData {
  const lines = overrides.lines ?? manyLines(1);
  const netTotal = lines.reduce((sum, l) => sum + l.lineNetCents, 0);
  const taxTotal = Math.round(netTotal * 0.19);
  const grossTotal = netTotal + taxTotal;
  return {
    number: "RE-2056-00001",
    type: "INVOICE",
    issueDate: new Date("2056-03-10"),
    dueDate: new Date("2056-03-24"),
    currency: "EUR",
    seller: {
      name: "Muster GmbH",
      addressLine1: "Hauptstr. 1",
      postalCode: "12345",
      city: "Berlin",
      countryCode: "DE",
    },
    buyer: {
      name: "Kunde AG",
      addressLine1: "Kundenweg 2",
      postalCode: "54321",
      city: "Stadt",
      countryCode: "DE",
    },
    lines,
    taxSubtotals: [{ taxCategory: "S", taxRate: 19, netCents: netTotal, taxCents: taxTotal }],
    netTotalCents: netTotal,
    taxTotalCents: taxTotal,
    grossTotalCents: grossTotal,
    payableCents: grossTotal,
    iban: "DE02120300000000202051",
    bic: null,
    bankName: "Testbank",
    giroAmountCents: grossTotal,
    ...overrides,
  };
}

describe("PdfTheme — Seitenzahlen (pdf-parse)", () => {
  it("eine lange Rechnung mit vielen Positionen erhält 'Seite 1 von 2' unten rechts", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ lines: manyLines(60), number: "RE-2056-00010", giroAmountCents: 0 });
    const pdf = await renderInvoicePdf(data, theme);
    const parsed = await pdfParse(pdf);
    expect(parsed.numpages).toBeGreaterThanOrEqual(2);
    expect(parsed.text).toContain("Seite 1 von 2");
  });

  it("eine kurze Rechnung bleibt einseitig, keine 'Seite x von y'-Zeile, wenn showPageNumbers aus ist", async () => {
    const orgId = await makeOrg();
    await savePrintSettings(orgId, { showPageNumbers: false });
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ giroAmountCents: 0 });
    const pdf = await renderInvoicePdf(data, theme);
    const parsed = await pdfParse(pdf);
    expect(parsed.text).not.toContain("Seite 1 von");
  });
});

describe("PdfTheme — GiroCode (§37)", () => {
  it("mit IBAN + showGiroCode an: das PDF enthält ein Image-XObject (QR-Code-PNG)", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ number: "RE-2056-00002" });
    const pdf = await renderInvoicePdf(data, theme);
    expect(pdf.toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
  });

  it("ohne IBAN: kein GiroCode, kein Image-XObject", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ number: "RE-2056-00003", iban: null, bic: null });
    const pdf = await renderInvoicePdf(data, theme);
    expect(pdf.toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
  });

  it("Gutschrift (CREDIT_NOTE): kein GiroCode", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ number: "GS-2056-00001", type: "CREDIT_NOTE" });
    const pdf = await renderInvoicePdf(data, theme);
    expect(pdf.toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
  });

  it("showGiroCode aus: kein GiroCode trotz IBAN", async () => {
    const orgId = await makeOrg();
    await savePrintSettings(orgId, { showGiroCode: false });
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ number: "RE-2056-00004" });
    const pdf = await renderInvoicePdf(data, theme);
    expect(pdf.toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
  });

  it("offener Betrag 0 (vollständig bezahlt): kein GiroCode", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ number: "RE-2056-00005", giroAmountCents: 0 });
    const pdf = await renderInvoicePdf(data, theme);
    expect(pdf.toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
  });
});

describe("PdfTheme — Lieferschein-Lieferadresse (§36)", () => {
  function baseDeliveryNoteData(overrides: Partial<DeliveryNotePdfData> = {}): DeliveryNotePdfData {
    return {
      number: "LS-2056-00001",
      issueDate: new Date("2056-03-10"),
      currency: "EUR",
      seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin" },
      buyer: { name: "Lieferadressen-Kunde AG", addressLine1: "Lieferweg 9", postalCode: "99999", city: "Lieferstadt" },
      lines: [{ pos: 1, description: "Testartikel", quantityMilli: 1000, unit: "C62" }],
      showPrices: false,
      showTax: false,
      showArticleNumber: false,
      showDescription: true,
      showDeliveryAddress: true,
      ...overrides,
    };
  }

  it("showDeliveryAddress an: die Empfängeradresse steht im PDF-Text", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const pdf = await renderDeliveryNotePdf(baseDeliveryNoteData({ showDeliveryAddress: true }), theme);
    const parsed = await pdfParse(pdf);
    expect(parsed.text).toContain("Lieferadressen-Kunde AG");
    expect(parsed.text).toContain("Lieferweg 9");
  });

  it("showDeliveryAddress aus: die Empfängeradresse fehlt im PDF-Text", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const pdf = await renderDeliveryNotePdf(baseDeliveryNoteData({ showDeliveryAddress: false }), theme);
    const parsed = await pdfParse(pdf);
    expect(parsed.text).not.toContain("Lieferadressen-Kunde AG");
    expect(parsed.text).not.toContain("Lieferweg 9");
  });
});

describe("PdfTheme — showPaymentTermsText (§33 DocumentSettings)", () => {
  it("an (Default): die Zahlungsziel-/Skonto-Zeile steht im PDF-Text", async () => {
    const orgId = await makeOrg();
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    const data = baseInvoiceData({ number: "RE-2056-00007", giroAmountCents: 0, paymentTermsHuman: "Zahlbar bis 24.03.2056 ohne Abzug." });
    const pdf = await renderInvoicePdf(data, theme);
    const parsed = await pdfParse(pdf);
    expect(parsed.text).toContain("Zahlbar bis 24.03.2056 ohne Abzug.");
  });

  it("aus: die Zahlungsziel-/Skonto-Zeile fehlt im PDF-Text", async () => {
    const orgId = await makeOrg();
    await saveDocumentSettings(orgId, { showPaymentTermsText: false });
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    expect(theme.showPaymentTermsText).toBe(false);
    const data = baseInvoiceData({ number: "RE-2056-00008", giroAmountCents: 0, paymentTermsHuman: "Zahlbar bis 24.03.2056 ohne Abzug." });
    const pdf = await renderInvoicePdf(data, theme);
    const parsed = await pdfParse(pdf);
    expect(parsed.text).not.toContain("Zahlbar bis 24.03.2056 ohne Abzug.");
  });
});

describe("loadPdfTheme — fehlende Logo-/Hintergrunddatei", () => {
  it("rendert ohne Logo, wenn logoPath auf eine nicht existierende Datei zeigt (kein Wurf)", async () => {
    const orgId = await makeOrg();
    await dbInternal.brandingSettings.create({ data: { orgId, logoPath: "does/not/exist.png" } });
    const theme = await loadPdfTheme(orgId);
    theme.compress = false; // Fix-Runde 1: Produktions-Default ist compress:true; Tests brauchen pdf-parse-kompatible PDFs.
    expect(theme.logoBuffer).toBeUndefined();
    const data = baseInvoiceData({ number: "RE-2056-00006", giroAmountCents: 0 });
    await expect(renderInvoicePdf(data, theme)).resolves.toBeInstanceOf(Buffer);
  });
});
