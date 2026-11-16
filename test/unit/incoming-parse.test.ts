import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIncomingXml } from "@/domain/incoming/parse";
import { MAX_INCOMING_LINES } from "@/domain/incoming/limits";
import { parsedIncomingInvoiceSchema } from "@/schemas/incoming";

const fx = (name: string): string => readFileSync(`test/fixtures/incoming/${name}`, "utf8");

const SAMPLES = [
  "base",
  "doc-discount-two-rates",
  "skonto-two-terms",
  "foreign-currency-usd",
  "lastschrift-59",
  "abo-verbrauch-subcent",
  "credit-note-doc-discount",
];

describe("parseIncomingXml", () => {
  it.each(SAMPLES)("UBL und CII von %s liefern dieselben Kopf- und Summenwerte", (name) => {
    const u = parseIncomingXml(fx(`gen-${name}-ubl.xml`));
    const c = parseIncomingXml(fx(`gen-${name}-cii.xml`));
    expect(u.syntax).toBe("UBL");
    expect(c.syntax).toBe("CII");
    for (const k of ["typeCode", "number", "issueDate", "deliveryDate", "currency", "buyerReference", "totals", "lineCount"] as const) {
      expect(c[k], k).toEqual(u[k]);
    }
    expect({ ...c.seller, contact: c.seller.contact?.email }).toEqual({ ...u.seller, contact: u.seller.contact?.email });
    expect(c.buyer.name).toBe(u.buyer.name);
    expect(c.lines.map((l) => [l.name, l.quantity, l.unitCode, l.unitPrice, l.netCents, l.vatCategory, l.vatRate])).toEqual(
      u.lines.map((l) => [l.name, l.quantity, l.unitCode, l.unitPrice, l.netCents, l.vatCategory, l.vatRate]),
    );
    expect(c.taxes).toEqual(u.taxes);
    expect(parsedIncomingInvoiceSchema.safeParse(u).success).toBe(true);
    expect(parsedIncomingInvoiceSchema.safeParse(c).success).toBe(true);
  });

  it("liest Summen, Steuerzeilen und Rabatt exakt", () => {
    const r = parseIncomingXml(fx("gen-doc-discount-two-rates-ubl.xml"));
    expect(r.totals).toMatchObject({
      lineNetCents: 36500,
      allowanceCents: 3650,
      netCents: 32850,
      taxCents: 5378,
      grossCents: 38228,
      payableCents: 38228,
    });
    expect(r.taxes.map((t) => [t.category, t.rate, t.basisCents, t.taxCents])).toEqual([
      ["S", "7", 7200, 504],
      ["S", "19", 25650, 4874],
    ]);
    expect(r.number).toBe("RE-2034-0003");
    expect(r.dueDate).toBe("2034-07-09");
    expect(r.seller).toMatchObject({ name: "Muster Handwerk GmbH", vatId: "DE123456789" });
    expect(r.seller.address).toMatchObject({ city: "Lüneburg", postalCode: "21337", countryCode: "DE" });
  });

  it("Sub-Cent-Einzelpreise und Mengen bleiben als Text erhalten", () => {
    const r = parseIncomingXml(fx("gen-abo-verbrauch-subcent-cii.xml"));
    expect(r.lines.map((l) => l.unitPrice)).toEqual(["29.00", "0.00200", "0.01234"]);
    expect(r.lines.map((l) => l.quantity)).toEqual(["1", "10000", "1.234"]);
  });

  it("Fremdwaehrung: Steuerbetrag in Belegwaehrung", () => {
    const r = parseIncomingXml(fx("gen-foreign-currency-usd-ubl.xml"));
    expect(r.currency).toBe("USD");
    expect(r.totals.taxCents).toBe(2131);
  });

  it("Praefix und Default-Namensraum mit anderer Reihenfolge ergeben dasselbe Ergebnis", () => {
    const a = parseIncomingXml(fx("ubl-invoice-praefix.xml"));
    const b = parseIncomingXml(fx("gen-doc-discount-two-rates-ubl.xml"));
    expect(a).toEqual(b);
  });

  it("Gutschrift und Selbstabrechnung", () => {
    expect(parseIncomingXml(fx("ubl-creditnote.xml")).typeCode).toBe("381");
    expect(parseIncomingXml(fx("gen-credit-note-doc-discount-cii.xml")).typeCode).toBe("381");
    expect(parseIncomingXml(fx("cii-389-selbstabrechnung.xml")).typeCode).toBe("389");
  });

  it("Lastschrift: Mandat und IBAN", () => {
    const u = parseIncomingXml(fx("gen-lastschrift-59-ubl.xml"));
    const c = parseIncomingXml(fx("gen-lastschrift-59-cii.xml"));
    expect(u.payment.means[0]).toMatchObject({ code: "59", mandateRef: "MANDAT-2183-001" });
    expect(c.payment.means[0]).toMatchObject({ code: "59", mandateRef: "MANDAT-2183-001", iban: "DE02120300000000202051" });
  });

  it("Anlage (BG-24): Inhalt nicht im Modell, nur Groesse, Name und MIME", () => {
    const r = parseIncomingXml(fx("ubl-anlage-bg24.xml"));
    expect(r.attachments).toEqual([
      { index: 0, id: "ANL-1", description: "Leistungsnachweis", mime: "application/pdf", fileName: "nachweis.pdf", size: 8, externalUri: null },
      { index: 1, id: "ANL-2", description: null, mime: null, fileName: null, size: null, externalUri: "https://example.org/nachweis" },
    ]);
    expect(JSON.stringify(r)).not.toContain("UERGLUZBS0U=");
  });

  it("Summen werden gelesen, nicht nachgerechnet", () => {
    const r = parseIncomingXml(fx("cii-summen-falsch.xml"));
    expect(r.totals.grossCents).toBe(99999);
    expect(r.totals.payableCents).toBe(38228);
  });

  it("Ueberlauf und ungueltige Betraege -> null mit Hinweis, kein Abbruch", () => {
    const r = parseIncomingXml(fx("ubl-betrag-ueberlauf.xml"));
    expect(r.totals.payableCents).toBeNull();
    expect(r.totals.grossCents).toBeNull();
    expect(r.totals.netCents).toBe(43400);
    expect(r.hints).toContainEqual({ code: "AMOUNT_OVERFLOW", field: "totals.payable" });
    expect(r.hints).toContainEqual({ code: "AMOUNT_INVALID", field: "totals.gross" });
  });

  it("MINIMUM und BASIC WL: Kopf und Summen, keine Positionen", () => {
    const r = parseIncomingXml(fx("cii-minimum.xml"));
    expect(r).toMatchObject({ isEInvoice: false, lineCount: 0, number: "MIN-0001" });
    expect(r.totals).toMatchObject({ netCents: 10000, taxCents: 1900, grossCents: 11900 });
  });

  it("ZUGFeRD 1.0: nur Kopf, mit Hinweis", () => {
    const r = parseIncomingXml(fx("ferd-1p0.xml"));
    expect(r).toMatchObject({ syntax: "FERD1", isEInvoice: false, number: "ZF1-0001", issueDate: "2034-06-09", currency: "EUR" });
    expect(r.totals.grossCents).toBe(11900);
    expect(r.hints).toContainEqual({ code: "ZUGFERD_1_LIMITED", field: null });
  });

  it("ungueltiges Datum -> null mit Hinweis", () => {
    const r = parseIncomingXml(fx("gen-base-ubl.xml").replace("<cbc:IssueDate>2026-06-09</cbc:IssueDate>", "<cbc:IssueDate>2026-02-30</cbc:IssueDate>"));
    expect(r.issueDate).toBeNull();
    expect(r.hints).toContainEqual({ code: "DATE_INVALID", field: "issueDate" });
  });

  it("ab der 5.001. Position wird abgebrochen", () => {
    const xml = fx("gen-base-ubl.xml");
    const line = /<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/.exec(xml)?.[0] ?? "";
    expect(line).not.toBe("");
    const big = xml.replace(/<cac:InvoiceLine>[\s\S]*<\/cac:InvoiceLine>/, line.repeat(MAX_INCOMING_LINES + 1));
    const r = parseIncomingXml(big);
    expect(r.lines).toHaveLength(MAX_INCOMING_LINES);
    expect(r.lineCount).toBe(MAX_INCOMING_LINES + 1);
    expect(r.linesTruncated).toBe(true);
    expect(r.hints).toContainEqual({ code: "LINES_TRUNCATED", field: "lines" });
    expect(parsedIncomingInvoiceSchema.safeParse(r).success).toBe(true);
  });

  it("lange Texte werden gekuerzt", () => {
    const r = parseIncomingXml(fx("gen-base-ubl.xml").replace("<cbc:BuyerReference>04011000-12345-86</cbc:BuyerReference>", `<cbc:BuyerReference>${"x".repeat(2000)}</cbc:BuyerReference>`));
    expect(r.buyerReference).toHaveLength(1000);
    expect(r.hints).toContainEqual({ code: "TEXT_TRUNCATED", field: "buyerReference" });
  });

  it("Entities und DTD erreichen den Parser nicht", () => {
    expect(() => parseIncomingXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>')).toThrow(/Markup/);
  });
});
