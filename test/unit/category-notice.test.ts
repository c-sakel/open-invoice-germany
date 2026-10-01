/**
 * A2/A3 — Pflichthinweis je Steuerkategorie (auch bei Regelbesteuerung), Schema NICHT_STEUERBAR
 * (Kategorie O), PDF-Ausdruck je Kategorie, E-Rechnung-Konsistenz (BT-120/BT-121).
 */
import { describe, it, expect } from "vitest";
import { CATEGORY_NOTICE, SCHEME_NOTICE, categoryNoticesToPrint, validateMandatoryFields, type MandatoryInvoice } from "@/domain/invoice/mandatory";
import { defaultCategoryForScheme, ZERO_TAX_SCHEMES } from "@/lib/tax";
import { exemptionReasonCode, exemptionReasonText } from "@/lib/einvoice/exemption";
import { TaxScheme } from "@/schemas";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { referenzInvoice, referenzTheme } from "../helpers/pdf-referenz-fixture";
import { parsePdf } from "../helpers/pdf-theme";

describe("categoryNoticesToPrint", () => {
  it("S ohne Hinweis; G/K/AE/E/Z/O mit eigenem Text", () => {
    expect(categoryNoticesToPrint(["S"], null)).toEqual([]);
    expect(categoryNoticesToPrint(["G"], null)).toEqual(["Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a i. V. m. § 6 UStG)"]);
    expect(categoryNoticesToPrint(["K"], "")).toEqual([SCHEME_NOTICE.IG_LIEFERUNG]);
    expect(categoryNoticesToPrint(["AE"], undefined)).toEqual(["Steuerschuldnerschaft des Leistungsempfängers"]);
    expect(categoryNoticesToPrint(["E"], null)).toEqual(["Steuerfreie Leistung"]);
    expect(categoryNoticesToPrint(["Z"], null)).toEqual([CATEGORY_NOTICE.Z]);
    expect(categoryNoticesToPrint(["O"], null)).toEqual(["Nicht im Inland steuerbare Leistung (Leistungsort außerhalb Deutschlands, § 3a UStG)"]);
  });

  it("keine Dublette, wenn der Hinweistext den Grund bereits nennt (Schemahinweis)", () => {
    expect(categoryNoticesToPrint(["G"], SCHEME_NOTICE.AUSFUHR)).toEqual([]);
    expect(categoryNoticesToPrint(["O"], SCHEME_NOTICE.NICHT_STEUERBAR)).toEqual([]);
    expect(categoryNoticesToPrint(["E"], SCHEME_NOTICE.KLEINUNTERNEHMER)).toEqual([]);
    expect(categoryNoticesToPrint(["E"], SCHEME_NOTICE.DIFFERENZ)).toEqual([]);
    expect(categoryNoticesToPrint(["AE"], "Hinweis: Steuerschuldnerschaft des Leistungsempfängers")).toEqual([]);
  });

  it("mehrere Kategorien: je Kategorie genau ein Hinweis, S bleibt still", () => {
    expect(categoryNoticesToPrint(["S", "G", "G", "O"], "Danke")).toHaveLength(2);
  });

  it("Texte stimmen mit der E-Rechnung ueberein (BT-120/BT-121 aus exemption.ts)", () => {
    // Pflichthinweis (PDF) und BT-120 sind verschiedene Felder; Kategorie-Abdeckung muss gleich sein.
    for (const cat of ["AE", "K", "G", "E", "Z", "O"]) expect(exemptionReasonText(cat)).not.toBeNull();
    expect(exemptionReasonCode("O")).toBe("VATEX-EU-O");
    expect(exemptionReasonCode("G")).toBe("VATEX-EU-G");
  });
});

describe("Schema NICHT_STEUERBAR", () => {
  it("ist gueltiges TaxScheme, Kategorie O, Nullsatz-Schema", () => {
    expect(TaxScheme.parse("NICHT_STEUERBAR")).toBe("NICHT_STEUERBAR");
    expect(defaultCategoryForScheme("NICHT_STEUERBAR")).toBe("O");
    expect(ZERO_TAX_SCHEMES.has("NICHT_STEUERBAR")).toBe(true);
    expect(SCHEME_NOTICE.NICHT_STEUERBAR).toContain("§ 3a UStG");
  });

  const base: MandatoryInvoice = {
    taxScheme: "NICHT_STEUERBAR",
    issueDate: "2076-06-01",
    deliveryDate: "2076-06-01",
    notes: SCHEME_NOTICE.NICHT_STEUERBAR,
    lines: [{ description: "Hosting", quantityMilli: 1000, taxRate: 0, taxCategory: "O" }],
    org: { legalName: "A GmbH", addressLine1: "Weg 1", postalCode: "10117", city: "Berlin", taxNumber: "12/345/67890", vatId: null },
    customer: { name: "Jane Example", addressLine1: "1 Sample Street", postalCode: "2000", city: "Sydney", countryCode: "AU" },
  };

  it("vollstaendiger Beleg ohne Befund; fehlender Hinweis, Steuersatz > 0 und Fremdkategorie werden gemeldet", () => {
    expect(validateMandatoryFields(base)).toEqual([]);
    expect(validateMandatoryFields({ ...base, notes: "" }).join(" ")).toContain("NICHT_STEUERBAR");
    expect(validateMandatoryFields({ ...base, lines: [{ ...base.lines[0]!, taxRate: 19, taxCategory: "O" }] }).join(" ")).toContain("USt-Satz > 0");
    expect(validateMandatoryFields({ ...base, lines: [...base.lines, { description: "x", quantityMilli: 1000, taxRate: 19, taxCategory: "S" }] }).join(" ")).toContain("BR-O-11");
  });

  it("Korrekturbelege (Storno/Gutschrift) bleiben ohne die neue Kategorie-Pruefung", () => {
    const mixed = { ...base, notes: "", lines: [...base.lines, { description: "x", quantityMilli: 1000, taxRate: 0, taxCategory: "S" }] };
    expect(validateMandatoryFields(mixed, { isCorrection: true }).join(" ")).not.toContain("BR-O-11");
  });
});

describe("PDF-Ausdruck des Kategorie-Hinweises", () => {
  async function textFor(category: string, notes: string | null): Promise<string> {
    const d = referenzInvoice();
    d.notes = notes;
    d.lines = d.lines.map((l) => ({ ...l, taxRate: 0, taxCategory: category }));
    d.taxSubtotals = [{ taxRate: 0, taxCategory: category, netCents: d.netTotalCents, taxCents: 0 }];
    d.taxTotalCents = 0;
    d.grossTotalCents = d.netTotalCents;
    d.payableCents = d.netTotalCents;
    d.giroAmountCents = d.netTotalCents;
    return (await parsePdf(await renderInvoicePdf(d, referenzTheme({ layoutId: "standard" })))).text;
  }

  it.each([
    ["G", "Steuerfreie Ausfuhrlieferung", "steuerfreie Ausfuhr"],
    ["K", "Steuerfreie innergemeinschaftliche Lieferung", "ig. Lieferung"],
    ["AE", "Steuerschuldnerschaft des Leistungsempfängers", "Reverse Charge"],
    ["Z", "§ 12 Abs. 3 UStG", "Nullsatz"],
    ["O", "Nicht im Inland steuerbare Leistung", "nicht steuerbar"],
  ])("Kategorie %s druckt Hinweis und 0-%%-Steuerzeile", async (cat, notice, rowLabel) => {
    const text = await textFor(cat, null);
    expect(text).toContain(notice);
    expect(text).toContain(`Umsatzsteuer 0 % (${rowLabel})`);
  });

  it("Kategorie E: Hinweis, aber keine USt-Zeile (Kleinunternehmer/§ 25a: kein Ausweis)", async () => {
    const text = await textFor("E", null);
    expect(text).toContain("Steuerfreie Leistung");
    expect(text).not.toContain("Umsatzsteuer 0 %");
  });

  it("Regelbesteuerung (S, 19 %): kein zusaetzlicher Hinweis", async () => {
    const text = await parsePdf(await renderInvoicePdf(referenzInvoice(), referenzTheme({ layoutId: "standard" })));
    expect(text.text).not.toMatch(/Steuerfreie|Nicht im Inland|Nullsatz/);
  });
});
