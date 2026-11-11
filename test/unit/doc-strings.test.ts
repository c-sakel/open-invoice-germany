import { describe, it, expect } from "vitest";
import { de } from "@/lib/i18n/doc/de";
import { en } from "@/lib/i18n/doc/en";
import { DOC_LANGUAGES, docStrings, docLocale, formatDocDate, formatDocMoney, resolveDocLanguage } from "@/lib/i18n/doc";
import { SCHEME_NOTICE_BY_LANG, validateMandatoryFields, type MandatoryInvoice } from "@/domain/invoice/mandatory";
import { paymentTermsText, skontoTerms } from "@/lib/pricing/skonto";
import { countryName, countryNameDe, addressCountryLine } from "@/lib/countries";
import { TaxScheme } from "@/schemas";

/** Beispielargumente je Funktion: Strings fuer alle Positionen, Zahlen fuer number-Parameter. */
function sample(fn: (...a: never[]) => unknown): string {
  const args = ["A", "B", "C", "D", "E"].slice(0, fn.length);
  const numeric = /^\(\s*(?:n|rate|level|days|year)\b/;
  const src = fn.toString();
  const call = numeric.test(src) ? args.map((_, i) => (i === 0 ? 1 : 2)) : args;
  return String((fn as (...a: unknown[]) => unknown)(...call));
}

function walk(a: unknown, b: unknown, path: string, problems: string[]): void {
  if (typeof a === "function") {
    if (typeof b !== "function") return void problems.push(`${path}: keine Funktion`);
    // Mehrere Parameter koennen Zahlen sein: beide Varianten probieren.
    const out = [sample(a as never), sample(b as never)];
    if (out.some((o) => o.trim() === "")) problems.push(`${path}: leerer Rueckgabewert`);
    return;
  }
  if (typeof a === "string") {
    if (typeof b !== "string" || b.trim() === "") problems.push(`${path}: fehlt/leer`);
    return;
  }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object") return void problems.push(`${path}: fehlt`);
    for (const key of Object.keys(a)) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, problems);
    return;
  }
  problems.push(`${path}: unerwarteter Typ`);
}

describe("Belegtexte de/en", () => {
  it("jeder deutsche Schluessel existiert in en und ist nicht leer", () => {
    const problems: string[] = [];
    walk(de, en, "doc", problems);
    expect(problems).toEqual([]);
  });

  it("en hat keine zusaetzlichen Schluessel (Strukturgleichheit)", () => {
    const problems: string[] = [];
    walk(en, de, "doc", problems);
    expect(problems).toEqual([]);
  });

  it("resolveDocLanguage", () => {
    expect(resolveDocLanguage("EN")).toBe("en");
    expect(resolveDocLanguage("en")).toBe("en");
    for (const v of ["fr", null, undefined, "", "de"]) expect(resolveDocLanguage(v)).toBe("de");
    expect(DOC_LANGUAGES).toEqual(["de", "en"]);
    expect(docStrings("en")).toBe(en);
    expect(docLocale("en")).toBe("en-GB");
    expect(docLocale("de")).toBe("de-DE");
  });

  it("Pflichthinweise en: exakter Wortlaut mit deutschem Wortlaut in Klammern", () => {
    expect(en.schemeNotice.REVERSE_CHARGE).toBe("Reverse charge (Steuerschuldnerschaft des Leistungsempfängers)");
    expect(en.schemeNotice.IG_LEISTUNG).toBe("Reverse charge (Steuerschuldnerschaft des Leistungsempfängers)");
    expect(en.schemeNotice.IG_LIEFERUNG).toBe("Tax-exempt intra-Community supply (Steuerfreie innergemeinschaftliche Lieferung, § 4 Nr. 1 Buchst. b i. V. m. § 6a UStG)");
    expect(en.schemeNotice.KLEINUNTERNEHMER).toBe("Small business under section 19 UStG, no VAT charged (Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer)");
    expect(en.schemeNotice.AUSFUHR).toMatch(/^Tax-exempt export supply \(Steuerfreie Ausfuhrlieferung, § 4 Nr\. 1 Buchst\. a i\. V\. m\. § 6 UStG\)$/);
    expect(en.schemeNotice.NICHT_STEUERBAR).toMatch(/\(Nicht im Inland steuerbare Leistung, .*§ 3a UStG\)$/);
    expect(en.schemeNotice.DIFFERENZ).toMatch(/\(Gebrauchtgegenstände\/Sonderregelung, § 25a UStG\)$/);
  });

  it("de.schemeNotice entspricht dem bisherigen Wortlaut (SCHEME_NOTICE)", () => {
    expect(SCHEME_NOTICE_BY_LANG.de).toBe(de.schemeNotice);
    expect(de.schemeNotice.KLEINUNTERNEHMER).toBe("Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer");
  });

  it("jedes Schema: der englische Hinweis erfuellt die Pflichtangaben-Pruefung", () => {
    const base = (scheme: string, notes: string): MandatoryInvoice => ({
      taxScheme: scheme,
      issueDate: new Date("2041-06-09"),
      deliveryDate: new Date("2041-06-01"),
      notes,
      lines: [{ description: "Leistung", quantityMilli: 1000, taxRate: 0, taxCategory: "O" }],
      org: { legalName: "Test GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789" },
      customer: { name: "Kunde", addressLine1: "Rue 1", postalCode: "75001", city: "Paris", vatId: "FR12345678901", countryCode: "US" },
    });
    for (const scheme of TaxScheme.options) {
      if (scheme === "REGULAR") continue;
      const problems = validateMandatoryFields(base(scheme, en.schemeNotice[scheme]));
      expect(problems.filter((p) => p.startsWith("Pflichthinweis")), scheme).toEqual([]);
    }
  });

  it("Umrechnungskurs-Zeile und Monatsquelle", () => {
    expect(de.fx.rateLine("1,1214", "USD", "EZB-Referenzkurs", "10.11.2026")).toBe("Umrechnungskurs: 1 EUR = 1,1214 USD (EZB-Referenzkurs vom 10.11.2026)");
    expect(en.fx.rateLine("1.1214", "USD", "ECB reference rate", "10/11/2026")).toBe("Exchange rate: 1 EUR = 1.1214 USD (ECB reference rate of 10/11/2026)");
    expect(de.fx.monthlyRateLabel(2109, 3)).toBe("Monatsdurchschnittskurs März 2109");
    expect(en.fx.monthlyRateLabel(2109, 3)).toBe("monthly average rate March 2109");
  });

  it("Formatierer je Sprache", () => {
    const d = new Date("2109-03-12T10:00:00Z");
    expect(formatDocDate(d, "de")).toBe("12.03.2109");
    expect(formatDocDate(d, "en")).toBe("12/03/2109");
    expect(formatDocMoney(1900, "EUR", "en")).toBe("€19.00");
    expect(formatDocMoney(1900, "EUR", "de").replace(/\s/g, " ")).toBe("19,00 €");
  });

  it("Zahlungsbedingungen: Default deutsch unveraendert, en englisch", () => {
    const terms = skontoTerms({ issueDate: new Date("2034-06-01T00:00:00Z"), grossTotalCents: 119000, skonto1Permille: 20, skonto1Days: 9, skonto2Permille: null, skonto2Days: null });
    const due = new Date("2034-06-17T00:00:00Z");
    expect(paymentTermsText(terms, due)).toBe(paymentTermsText(terms, due, "de"));
    expect(paymentTermsText(terms, due, "de")).toContain("2 % Skonto bei Zahlung bis 10.06.2034");
    expect(paymentTermsText(terms, due, "en")).toBe("2% cash discount if paid by 10/06/2034 (discount amount €23.80), payable net by 17/06/2034.");
  });

  it("Titel und Seitenzahl", () => {
    expect(de.titles.INVOICE).toBe("Rechnung");
    expect(en.titles.INVOICE).toBe("Invoice");
    expect(de.page(1, 3)).toBe("Seite 1 von 3");
    expect(en.page(1, 3)).toBe("Page 1 of 3");
  });

  it("feste Layout-/Quell-/System-Labels de byte-identisch zu den bisherigen Literalen", () => {
    expect(de.layoutLabels.schlicht).toMatchObject({ colEinzel: "Einzelpreis", colNetto: "Gesamtpreis", colPosSuffix: ".", net: "Gesamtbetrag netto", gross: "Gesamtbetrag brutto", giroCaption: "GiroCode" });
    expect(de.layoutLabels.schlicht.taxRow(19)).toBe("zzgl. Umsatzsteuer 19%");
    expect(de.meta.deliveryAddress).toBe("Lieferanschrift:");
    expect(de.meta.deliveryNoteAddress).toBe("Lieferadresse:");
    expect(de.sourceLabels).toEqual({ ANGEBOT: "Angebot", AUFTRAGSBESTAETIGUNG: "Auftrag", PROFORMA: "Proforma-Rechnung", DELIVERY_NOTE: "Lieferschein" });
    expect(de.system).toEqual({ draftNumber: "ENTWURF", previewWatermark: "VORSCHAU" });
    expect(en.system.previewWatermark).toBe("PREVIEW");
  });

  it("countryName je Sprache; de identisch zu countryNameDe", () => {
    expect(countryName("DE", "de")).toBe(countryNameDe("DE"));
    expect(countryName("AT", "de")).toBe("Österreich");
    expect(countryName("DE", "en")).toBe("Germany");
    expect(countryName("AT", "en")).toBe("Austria");
    expect(countryName("US", "en")).toBe("United States");
    expect(countryName("GB", "en")).toBe("United Kingdom");
    expect(countryName("US", "de")).toBe("Vereinigte Staaten");
    expect(countryName("xx1", "en")).toBeNull();
    expect(addressCountryLine("AT", "en")).toBe("AUSTRIA");
    expect(addressCountryLine("AT")).toBe("ÖSTERREICH");
  });
});
