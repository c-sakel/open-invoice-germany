/**
 * Phase 11b (PDF-Layouts), Task 2 — Layout-Register + `standard` (Kompatibilitaet).
 * Testjahr 2073 (siehe plan-header.md).
 */
import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { renderDeliveryNotePdf } from "@/lib/pdf/delivery-note-pdf";
import { renderDunningPdf } from "@/lib/pdf/dunning-pdf";
import { getLayout, listLayouts } from "@/lib/pdf/layouts/registry";
import { LAYOUT_IDS } from "@/lib/pdf/layouts/ids";
import { parsePdf, testPdfTheme } from "../helpers/pdf-theme";
import { sampleDeliveryNote, sampleDunning } from "../helpers/pdf-fixtures";
import type { EInvoiceData, EInvoiceLine } from "@/lib/einvoice/types";

/** Zaehlt nicht-ueberlappende Vorkommen von `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Fix-Runde 1 (Koordinator, Punkt 6): die Fusszeile wird jetzt auf JEDER Seite gezeichnet
// (vorher nur auf der zuletzt angelegten) — "IBAN" + die gruppierte IBAN (leerraum-
// bereinigt) muss deshalb mindestens `numpages`-mal im PDF-Text auftauchen, EINMAL je Seite.
const STRIPPED_IBAN_FOOTER = "IBANDE02120300000000202051";

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

/** Reine ITEM-Zeilen, keine Kopf-/Fusstexte/Rabatte — fuer die deterministische
 *  Paginierungs-Handrechnung unten (jede Abweichung waere sonst durch Textumbruch statt
 *  durch die Fusszeilen-Reservierung selbst verursacht). */
function invoiceWithLines(n: number): EInvoiceData {
  const lines: EInvoiceLine[] = Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    description: `Position ${i + 1}`,
    quantityMilli: 1000,
    unit: "C62",
    unitNetPriceCents: 1000,
    lineNetCents: 1000,
    taxRate: 19,
    taxCategory: "S",
    lineType: "ITEM" as const,
  }));
  const net = n * 1000;
  const tax = Math.round(net * 0.19);
  return {
    number: "RE-2073-00002",
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

describe("Layout-Register", () => {
  it("kennt 'standard', das der Fallback ist", () => {
    expect(listLayouts()[0]!.id).toBe("standard");
    expect(getLayout("gibtsnicht").id).toBe("standard");
    expect(getLayout(undefined).id).toBe("standard");
  });

  // Task 5: die Registry ist jetzt ein vollstaendiges `Record<LayoutId, PdfLayout>`
  // (kein `Partial` mehr) — `listLayouts()` muss deshalb exakt `LAYOUT_IDS` in
  // derselben Reihenfolge liefern, kein Layout fehlt.
  it("liefert alle sieben Layouts in der Reihenfolge von LAYOUT_IDS", () => {
    expect(listLayouts().map((l) => l.id)).toEqual([...LAYOUT_IDS]);
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
    const stripped = text.replace(/\s+/g, "");
    expect(stripped).toContain(STRIPPED_IBAN_FOOTER);
    // Fix-Runde 1, Punkt 6 — die Fusszeile steht jetzt auf JEDER Seite, nicht nur der letzten.
    expect(countOccurrences(stripped, STRIPPED_IBAN_FOOTER)).toBeGreaterThanOrEqual(numpages);
    expect(text).toContain("Gesamtbetrag");
  });
});

describe("standard — Fusszeilen-reservierte Paginierung (Fix-Runde 2, Critical)", () => {
  it("mit Fusszeile passen weniger Positionen auf eine Seite als ohne (pageBottom reserviert layout.footerHeight + 6pt)", async () => {
    // Handrechnung (schwarz auf weiss, statt eine interne itemRowsPerPage()-Hilfsfunktion
    // zu exportieren — der Test bleibt black-box und prueft nur renderInvoicePdf/parsePdf):
    //   A4 = 595.28 x 841.89pt (pdfkit-Seitengroessentabelle).
    //   MM_TO_PT = 2.834645 (src/lib/pdf/marks.ts).
    //   Defaults (DEFAULT_BRANDING_SETTINGS): marginTopMm = marginBottomMm = 20mm
    //     -> marginTop = marginBottom = 20 * 2.834645 = 56.6929pt.
    //   standard.footerHeight = 46; rowH = Math.round((base-1)*1.8) mit base=10 (Default
    //     fontSizePt) = Math.round(9*1.8) = 16.
    //   Tabellenbeginn Seite 1 (invoiceWithLines() setzt KEINEN Kopftext/keine
    //     Lieferadresse): standard.drawKopf liefert margins.top + 170 = 226.6929;
    //     + Tabellenkopf (headerHeight 18 + 4 Abstand) = 248.6929 =: y1.
    //   Folgeseiten beginnen bei margins.top (kein drawPageChrome fuer `standard`) + 22
    //     Tabellenkopf = 78.6929 =: y2.
    //   pageBottom MIT Fusszeile  = 841.89 - 56.6929 - 46 - 6 = 733.1971 =: bF
    //   pageBottom OHNE Fusszeile = 841.89 - 56.6929            = 785.1971 =: bO
    //   Kapazitaet je Seite = floor((pageBottom - startY) / rowH):
    //     Seite 1 MIT:  floor((733.1971 - 248.6929) / 16) = floor(30.28) = 30
    //     Seite 1 OHNE: floor((785.1971 - 248.6929) / 16) = floor(33.53) = 33
    //     Folgeseite MIT:  floor((733.1971 - 78.6929) / 16) = floor(40.90) = 40
    //     Folgeseite OHNE: floor((785.1971 - 78.6929) / 16) = floor(44.16) = 44
    //   Kapazitaet ueber 2 Seiten: MIT 30+40=70, OHNE 33+44=77 Positionen. Bei den vom
    //   Koordinator vorgeschlagenen 60 Zeilen liegt WEDER 60 > 70 NOCH 60 > 77 — beide
    //   Faelle bleiben bei 2 Seiten, kein numerischer Unterschied messbar (per Debug-Sweep
    //   n=55..77 verifiziert, siehe Fix-Runde-2-Report). 70 ist der kleinste Wert, bei dem
    //   MIT Fusszeile bereits eine dritte Seite noetig ist, OHNE Fusszeile aber noch nicht.
    const withFooterTheme = testPdfTheme({ layoutId: "standard" });
    const withoutFooterTheme = testPdfTheme({ layoutId: "standard", options: { ...testPdfTheme().options, showFooter: false } });
    const withFooter = await parsePdf(await renderInvoicePdf(invoiceWithLines(70), withFooterTheme));
    const withoutFooter = await parsePdf(await renderInvoicePdf(invoiceWithLines(70), withoutFooterTheme));
    expect(withFooter.numpages).toBe(3);
    expect(withoutFooter.numpages).toBe(2);
    expect(withFooter.numpages).toBeGreaterThan(withoutFooter.numpages);
  });
});

// Phase 11b, Task 4/5 — Matrix ueber alle sieben Layouts. Jedes Layout muss dieselben
// Kernangaben drucken, egal wie es Kopf/Tabelle/Fusszeile zeichnet — die Renderer
// selbst bleiben layout-agnostisch.
const MATRIX = ["standard", "schlicht", "klassik", "modern", "blau", "schwarz", "kompakt"] as const;

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
    const stripped = text.replace(/\s+/g, "");
    expect(stripped, `${layoutId}: IBAN`).toContain(STRIPPED_IBAN_FOOTER);
    // Fix-Runde 1, Punkt 6 — die Fusszeile steht jetzt auf JEDER Seite, nicht nur der letzten.
    expect(countOccurrences(stripped, STRIPPED_IBAN_FOOTER), `${layoutId}: IBAN je Seite`).toBeGreaterThanOrEqual(numpages);
    // `kompakt` (Task 5: kleinere Zeilenhoehe, siehe invoice-pdf.ts#rowH) passt alle 30
    // Positionen inkl. Zwischenueberschrift auf die erste Tabellenseite — der Tabellenkopf
    // "Beschreibung" erscheint deshalb nur EINMAL (Seite 2 traegt nur noch Summen/Fusszeile,
    // keine weitere Tabellenseite); das ist der numerische Beleg fuer die kleinere Zeilenhoehe.
    // Alle anderen Layouts behalten die Zwei-Tabellenseiten-Erwartung aus Task 4.
    const minHeaderRepeats = layoutId === "kompakt" ? 1 : 2;
    expect((text.match(/Beschreibung/g) ?? []).length, `${layoutId}: Tabellenkopf-Wiederholungen`).toBeGreaterThanOrEqual(minHeaderRepeats);
    expect(text).not.toContain("GEHEIM");
  });

  it("Lieferschein und Mahnung rendern", async () => {
    const dn = await parsePdf(await renderDeliveryNotePdf(sampleDeliveryNote(), testPdfTheme({ layoutId })));
    expect(dn.text).toContain("Lieferschein");
    const du = await parsePdf(await renderDunningPdf(sampleDunning(), testPdfTheme({ layoutId })));
    expect(du.text).toMatch(/Mahnung|Zahlungserinnerung/);
  });
});
