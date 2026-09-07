/**
 * Phase 11b (PDF-Layouts), Task 2 — Layout-Register + `standard` (Kompatibilitaet).
 * Testjahr 2073 (siehe plan-header.md).
 */
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { getLayout, listLayouts } from "@/lib/pdf/layouts/registry";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";
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
  const data: EInvoiceData = {
    number: "RE-2073-00001",
    type: "INVOICE",
    issueDate: new Date("2073-05-02"),
    dueDate: new Date("2073-05-16"),
    deliveryDate: new Date("2073-05-01"),
    currency: "EUR",
    headerText: "Sehr geehrte Damen und Herren, vielen Dank für Ihren Auftrag.",
    footerText: "Wir bedanken uns für Ihr Vertrauen.",
    notes: "Sichtbare Notiz",
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
  // Negativtest (siehe MATRIX unten): `internalNotes` existiert nicht in `EInvoiceData` —
  // dieses Feld simuliert versehentlich durchgereichte interne Daten, damit der Test
  // sichert, dass kein Layout "GEHEIM" aus einem solchen Feld druckt.
  (data as unknown as Record<string, unknown>).internalNotes = "GEHEIM-NOTIZ";
  return data;
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

// Phase 11b, Task 4 — Matrix ueber alle bisher registrierten Layouts (Task 5 ergaenzt
// blau/schwarz/kompakt). Jedes Layout muss dieselben Kernangaben drucken, egal wie es
// Kopf/Tabelle/Fusszeile zeichnet — die Renderer selbst bleiben layout-agnostisch.
const MATRIX = ["standard", "schlicht", "klassik", "modern"] as const; // Task 5: + blau, schwarz, kompakt

describe.each(MATRIX)("Layout %s", (layoutId) => {
  it("Register enthaelt %s", () => {
    expect(getLayout(layoutId).id).toBe(layoutId);
  });

  it("Rechnung: zwei Seiten, Kernangaben, Fusszeile, kein Notizleck", async () => {
    const data = sampleInvoice();
    const pdf = await renderInvoicePdf(data, testPdfTheme({ layoutId, footerFacts: { ownerName: "Erika Muster", website: "muster.example" } }));
    const { text, numpages } = await parsePdf(pdf);
    expect(numpages).toBeGreaterThanOrEqual(2);
    for (const s of ["RE-2073-00001", "Kunde AG", "Abschnitt B", "Position 30", "Langtext", "Gesamtbetrag", "Inhaber/-in Erika Muster", "Seite 1 von"]) {
      expect(text, `${layoutId}: ${s}`).toContain(s);
    }
    // Wie in "Layout standard (Kompatibilitaet)" oben: die vierspaltige AUTO-Fusszeile
    // (drawFooterColumns, gemeinsame Infrastruktur aller Layouts) kann die gruppierte
    // IBAN innerhalb ihrer Spalte umbrechen — Leerraum vor dem Vergleich entfernen.
    expect(text.replace(/\s+/g, ""), `${layoutId}: IBAN`).toContain("DE02120300000000202051");
    expect((text.match(/Beschreibung/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain("GEHEIM");
  });

  it("Lieferschein und Mahnung rendern", async () => {
    const dn = await parsePdf(await renderDeliveryNotePdf(sampleDeliveryNote(), testPdfTheme({ layoutId })));
    expect(dn.text).toContain("Lieferschein");
    const du = await parsePdf(await renderDunningPdf(sampleDunning(), testPdfTheme({ layoutId })));
    expect(du.text).toMatch(/Mahnung|Zahlungserinnerung/);
  });
});
