/**
 * Phase 11b (PDF-Layouts), Task 2 — Layout-Register + `standard` (Kompatibilitaet).
 * Testjahr 2073 (siehe plan-header.md).
 */
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { getLayout, listLayouts } from "@/lib/pdf/layouts/registry";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";
import type { EInvoiceData, EInvoiceLine } from "@/lib/einvoice/types";

export function sampleInvoice(): EInvoiceData {
  const lines: EInvoiceLine[] = Array.from({ length: 30 }, (_, i) => ({
    id: String(i + 1),
    description: `Position ${i + 1}`,
    descriptionLong: i === 2 ? "**Langtext** mit Details\n- Punkt A\n- Punkt B" : undefined,
    quantityMilli: 2000,
    unit: "C62",
    unitNetPriceCents: 1250,
    lineNetCents: 2500,
    taxRate: 19,
    taxCategory: "S",
    lineType: "ITEM" as const,
    discountCents: i === 4 ? 250 : undefined,
    discountPermille: i === 4 ? 100 : undefined,
  }));
  lines.splice(10, 0, { id: "h1", description: "Abschnitt B", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, lineNetCents: 0, taxRate: 19, taxCategory: "S", lineType: "HEADING" as const });
  const net = 30 * 2500 - 250;
  const tax = Math.round(net * 0.19);
  return {
    number: "RE-2073-00001",
    type: "INVOICE",
    issueDate: new Date("2073-05-02"),
    dueDate: new Date("2073-05-16"),
    deliveryDate: new Date("2073-05-01"),
    currency: "EUR",
    headerText: "Sehr geehrte Damen und Herren, vielen Dank für Ihren Auftrag.",
    footerText: "Wir bedanken uns für Ihr Vertrauen.",
    seller: { name: "Muster GmbH", addressLine1: "Hauptstr. 1", postalCode: "12345", city: "Berlin", countryCode: "DE", vatId: "DE123456789", taxNumber: "12/345/67890", email: "info@muster.example", phone: "030 123456" },
    buyer: { name: "Kunde AG", contactName: "Frau Beispiel", addressLine1: "Kundenweg 2", postalCode: "54321", city: "Stadt", countryCode: "DE", vatId: "DE987654321" },
    lines,
    taxSubtotals: [{ taxRate: 19, taxCategory: "S", netCents: net, taxCents: tax }],
    netTotalCents: net,
    taxTotalCents: tax,
    grossTotalCents: net + tax,
    payableCents: net + tax,
    giroAmountCents: net + tax,
    iban: "DE02120300000000202051",
    bic: "BYLADEM1001",
    bankName: "Testbank",
    paymentTermsHuman: "Zahlbar innerhalb 14 Tagen ohne Abzug.",
  };
}

describe("Layout-Register", () => {
  it("kennt 'standard', das der Fallback ist (Register waechst bis Task 5)", () => {
    expect(listLayouts()[0]!.id).toBe("standard");
    expect(getLayout("gibtsnicht").id).toBe("standard");
    expect(getLayout(undefined).id).toBe("standard");
  });
});

describe("Layout standard (Kompatibilitaet)", () => {
  it("rendert die Musterrechnung mit allen Kernangaben auf zwei Seiten", async () => {
    const pdf = await renderInvoicePdf(sampleInvoice(), testPdfTheme({ layoutId: "standard" }));
    const { text, numpages } = await parsePdf(pdf);
    expect(numpages).toBe(2);
    expect(text).toContain("RE-2073-00001");
    expect(text).toContain("Kunde AG");
    expect(text).toContain("Abschnitt B");
    expect(text).toContain("Seite 1 von 2");
    expect(text).toContain("Seite 2 von 2");
    expect((text.match(/Beschreibung/g) ?? []).length).toBeGreaterThanOrEqual(2); // Tabellenkopf auf Seite 2 wiederholt
    // Phase 11b, Task 3 — die AUTO-Fusszeile gruppiert die IBAN in 4er-Bloecke
    // (footer.ts#groupIban, siehe test/unit/pdf-footer.test.ts) und die vierspaltige
    // Fusszeile kann eine so lange Zeile innerhalb ihrer Spalte umbrechen (pdf-parse
    // fuegt dafuer einen Zeilenumbruch ein) — Leerraum vor dem Vergleich entfernen, damit
    // die Pruefung unabhaengig von Gruppierung/Umbruch bleibt.
    expect(text.replace(/\s+/g, "")).toContain("DE02120300000000202051");
    expect(text).toContain("Gesamtbetrag");
  });
});
