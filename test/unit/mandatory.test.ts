import { describe, it, expect } from "vitest";
import { validateMandatoryFields, type MandatoryInvoice } from "@/domain/invoice/mandatory";

const org = { legalName: "A GmbH", addressLine1: "Str 1", postalCode: "12345", city: "X", vatId: "DE123456789" };
const customer = { name: "Kunde", addressLine1: "Y 2", postalCode: "54321", city: "Z", countryCode: "DE" };

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

  it("Reverse Charge korrekt (Hinweis + 0 % + Empfaenger-USt-IdNr.) ist ok", () => {
    const problems = validateMandatoryFields(
      inv({
        taxScheme: "REVERSE_CHARGE",
        customer: { ...customer, vatId: "DE111222333" },
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

const euCustomer = { name: "EU AG", addressLine1: "Rue 1", postalCode: "1000", city: "Bruessel", countryCode: "BE", vatId: "BE0123456789" };
const chCustomer = { name: "CH AG", addressLine1: "Weg 1", postalCode: "8000", city: "Zuerich", countryCode: "CH" };
const zeroLine = { description: "Leistung", quantityMilli: 1000, taxRate: 0, taxCategory: "E" };
const igNotes = "Steuerfreie innergemeinschaftliche Lieferung";

describe("Exakte Hinweispruefung (Phase 12b)", () => {
  it("aehnlicher, aber falscher Text wird abgelehnt; korrekter (auch mit Mehrfach-Whitespace) ist gruen", () => {
    const falsch = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: "Steuerfreie Lieferung nach Absprache", lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(falsch.join(" ")).toMatch(/Pflichthinweis für Schema IG_LIEFERUNG/); // Erst-Wort-Heuristik liess das durch
    expect(validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: "steuerfreie   innergemeinschaftliche lieferung", lines: [{ ...zeroLine, taxCategory: "K" }] }))).toEqual([]);
  });
  it("alle drei § 25a-Formulierungen sind gruen", () => {
    for (const t of ["Gebrauchtgegenstände/Sonderregelung", "Kunstgegenstände/Sonderregelung", "Sammlungsstücke und Antiquitäten/Sonderregelung"]) {
      expect(validateMandatoryFields(inv({ taxScheme: "DIFFERENZ", notes: t, lines: [zeroLine] }))).toEqual([]);
    }
  });
});

describe("Neue Blocker (Phase 12b)", () => {
  it("IG_LIEFERUNG ohne Datum und ohne Zeitraum blockt (BR-IC-11), mit Zeitraum ist ok", () => {
    const ohne = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: igNotes, deliveryDate: null, lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(ohne.join(" ")).toMatch(/Leistungsdatum oder Leistungszeitraum/);
    const mit = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: euCustomer, notes: igNotes, deliveryDate: null, deliveryStart: new Date("2026-06-01"), deliveryEnd: new Date("2026-06-30"), lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(mit).toEqual([]);
  });
  it("IG_LIEFERUNG mit deutscher Empfaenger-USt-IdNr. blockt (§ 6a Abs. 1 Nr. 4)", () => {
    const p = validateMandatoryFields(inv({ taxScheme: "IG_LIEFERUNG", customer: { ...euCustomer, vatId: "DE987654321" }, notes: igNotes, lines: [{ ...zeroLine, taxCategory: "K" }] }));
    expect(p.join(" ")).toMatch(/aus einem anderen EU-Mitgliedstaat/);
  });
  it("REVERSE_CHARGE ohne Empfaenger-USt-IdNr. blockt (BR-AE-3)", () => {
    const p = validateMandatoryFields(inv({ taxScheme: "REVERSE_CHARGE", notes: "Steuerschuldnerschaft des Leistungsempfängers", lines: [{ ...zeroLine, taxCategory: "AE" }] }));
    expect(p.join(" ")).toMatch(/USt-IdNr. des Empfängers erforderlich/);
  });
  it("AUSFUHR mit EU-Empfaenger blockt, mit Drittland ist ok, mit Satz > 0 blockt", () => {
    const notes = "Steuerfreie Ausfuhrlieferung";
    expect(validateMandatoryFields(inv({ taxScheme: "AUSFUHR", customer: euCustomer, notes, lines: [{ ...zeroLine, taxCategory: "G" }] })).join(" "))
      .toMatch(/außerhalb der EU/);
    expect(validateMandatoryFields(inv({ taxScheme: "AUSFUHR", customer: chCustomer, notes, lines: [{ ...zeroLine, taxCategory: "G" }] }))).toEqual([]);
    expect(validateMandatoryFields(inv({ taxScheme: "AUSFUHR", customer: chCustomer, notes, lines: [{ description: "L", quantityMilli: 1000, taxRate: 19, taxCategory: "G" }] })).join(" "))
      .toMatch(/USt-Satz > 0/);
  });
});
