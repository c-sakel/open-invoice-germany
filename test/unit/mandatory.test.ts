import { describe, it, expect } from "vitest";
import { validateMandatoryFields, type MandatoryInvoice } from "@/domain/invoice/mandatory";

const org = { legalName: "A GmbH", addressLine1: "Str 1", postalCode: "12345", city: "X", vatId: "DE123456789" };
const customer = { name: "Kunde", addressLine1: "Y 2", postalCode: "54321", city: "Z" };

function inv(extra: Partial<MandatoryInvoice> = {}): MandatoryInvoice {
  return {
    type: "INVOICE",
    taxScheme: "REGULAR",
    issueDate: new Date("2026-06-09"),
    deliveryDate: new Date("2026-06-01"),
    notes: "",
    lines: [{ description: "Leistung", quantityMilli: 1000, taxRate: 19, taxCategory: "S" }],
    org,
    customer,
    ...extra,
  };
}

describe("§ 14 Pflichtangaben", () => {
  it("vollständige Rechnung ist ok", () => {
    expect(validateMandatoryFields(inv())).toEqual([]);
  });

  it("erkennt fehlende Empfängeranschrift", () => {
    const problems = validateMandatoryFields(inv({ customer: { name: "K", addressLine1: "", postalCode: "", city: "" } }));
    expect(problems.join(" ")).toMatch(/Anschrift des Leistungsempfängers/);
  });

  it("erkennt fehlende Steuernummer/USt-IdNr. des Ausstellers", () => {
    const problems = validateMandatoryFields(inv({ org: { ...org, vatId: undefined, taxNumber: undefined } }));
    expect(problems.join(" ")).toMatch(/Steuernummer oder USt-IdNr/);
  });

  it("Reverse Charge ohne Hinweis und mit USt > 0 schlägt fehl", () => {
    const problems = validateMandatoryFields(inv({ taxScheme: "REVERSE_CHARGE", notes: "" }));
    expect(problems.join(" ")).toMatch(/Pflichthinweis für Schema REVERSE_CHARGE/);
    expect(problems.join(" ")).toMatch(/USt-Satz > 0/);
  });

  it("Reverse Charge korrekt (Hinweis + 0 %) ist ok", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "REVERSE_CHARGE",
        notes: "Steuerschuldnerschaft des Leistungsempfängers",
        lines: [{ description: "Leistung", quantityMilli: 1000, taxRate: 0, taxCategory: "AE" }],
      }),
    );
    expect(problems).toEqual([]);
  });

  it("Kleinbetragsrechnung erlaubt fehlende Empfängerangaben (§ 33 UStDV)", () => {
    const problems = validateMandatoryFields(
      inv({ isSmallAmount: true, customer: { name: "", addressLine1: "", postalCode: "", city: "" } }),
    );
    expect(problems).toEqual([]);
  });
});

describe("DRITTLAND_LEISTUNG (§ 3a Abs. 2)", () => {
  it("ohne Hinweis wird bemängelt", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "DRITTLAND_LEISTUNG",
        notes: "",
        lines: [{ description: "Software development", quantityMilli: 1000, taxRate: 0, taxCategory: "Z" }],
      }),
    );
    expect(problems.join(" ")).toMatch(/Pflichthinweis für Schema DRITTLAND_LEISTUNG/);
  });

  it("mit Hinweis und 0% ist ok", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "DRITTLAND_LEISTUNG",
        notes: "Nicht im Inland steuerbar gem. § 3a Abs. 2 UStG",
        lines: [{ description: "Software development", quantityMilli: 1000, taxRate: 0, taxCategory: "Z" }],
      }),
    );
    expect(problems).toEqual([]);
  });

  it("mit USt > 0 schlägt fehl (§ 14c-Risiko)", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "DRITTLAND_LEISTUNG",
        notes: "Nicht im Inland steuerbar",
        lines: [{ description: "Software development", quantityMilli: 1000, taxRate: 19, taxCategory: "Z" }],
      }),
    );
    expect(problems.join(" ")).toMatch(/USt-Satz > 0/);
  });

  it("erfordert keine USt-IdNr. des Empfängers (Drittland)", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "DRITTLAND_LEISTUNG",
        notes: "Nicht im Inland steuerbar gem. § 3a Abs. 2 UStG",
        lines: [{ description: "Software development", quantityMilli: 1000, taxRate: 0, taxCategory: "Z" }],
        customer: { name: "US Corp", addressLine1: "123 Main St", postalCode: "10001", city: "New York" },
      }),
    );
    expect(problems).toEqual([]);
  });
});

describe("IG_LIEFERUNG (§ 6a)", () => {
  it("erfordert USt-IdNr. beider Parteien", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "IG_LIEFERUNG",
        notes: "Steuerfreie innergemeinschaftliche Lieferung",
        lines: [{ description: "Ware", quantityMilli: 1000, taxRate: 0, taxCategory: "K" }],
      }),
    );
    expect(problems.join(" ")).toMatch(/USt-IdNr.*Empfänger/);
  });

  it("vollständig: Hinweis + 0% + USt-IdNr. beide → ok", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "IG_LIEFERUNG",
        notes: "Steuerfreie innergemeinschaftliche Lieferung",
        lines: [{ description: "Ware", quantityMilli: 1000, taxRate: 0, taxCategory: "K" }],
        customer: { name: "EU Corp", addressLine1: "Rue 1", postalCode: "75001", city: "Paris", vatId: "FR12345678901" },
      }),
    );
    expect(problems).toEqual([]);
  });
});
