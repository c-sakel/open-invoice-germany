import { describe, it, expect } from "vitest";
import { createInvoiceSchema, customerSchema, organizationSchema, directDebitSnapshotSchema } from "@/schemas";

const line = { description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S" };
const inv = { customerId: "c1", lines: [line] };
const cust = { name: "Kunde", addressLine1: "Weg 1", postalCode: "21357", city: "Bardowick" };
const org = { legalName: "Musterfirma GmbH", addressLine1: "Weg 1", postalCode: "21357", city: "Bardowick" };

describe("Karte am Beleg", () => {
  it("lehnt die volle Kartennummer ab, ohne sie in den Meldungen zu wiederholen", () => {
    const r = createInvoiceSchema.safeParse({ ...inv, cardPanTruncated: "4111111111111111" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const s = JSON.stringify(r.error.issues);
      expect(s).not.toContain("4111111111111111");
      expect(s).not.toContain("41111111");
      expect(s).toContain("vollständige Kartennummer");
    }
  });
  it("kürzt maskierte Eingabe", () => {
    const r = createInvoiceSchema.parse({ ...inv, cardPanTruncated: "**** 1234" });
    expect(r.cardPanTruncated).toBe("1234");
  });
  it("lehnt ungültiges Kartennetz ab", () => {
    expect(createInvoiceSchema.safeParse({ ...inv, cardNetwork: "<script>" }).success).toBe(false);
  });
});

describe("Lastschriftmandat am Kunden", () => {
  it("verlangt IBAN, wenn nur die Referenz gesetzt ist", () => {
    const r = customerSchema.safeParse({ ...cust, sepaMandateReference: "M-1" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0])).toContain("sepaDebitIban");
  });
  it("verlangt Referenz, wenn nur die IBAN gesetzt ist", () => {
    const r = customerSchema.safeParse({ ...cust, sepaDebitIban: "DE89370400440532013000" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0])).toContain("sepaMandateReference");
  });
  it("nimmt beide mit Datum an und normalisiert die IBAN", () => {
    const r = customerSchema.parse({ ...cust, sepaMandateReference: "M-1", sepaDebitIban: "de89 3704 0044 0532 0130 00", sepaMandateSignedAt: "2026-01-15" });
    expect(r.sepaDebitIban).toBe("DE89370400440532013000");
    expect(r.sepaMandateSignedAt).toBeInstanceOf(Date);
  });
  it("lehnt ungültige IBAN ab", () => {
    expect(customerSchema.safeParse({ ...cust, sepaMandateReference: "M-1", sepaDebitIban: "DE89370400440532013001" }).success).toBe(false);
  });
});

describe("Gläubiger-ID an der Organisation", () => {
  it("normalisiert", () => {
    expect(organizationSchema.parse({ ...org, sepaCreditorId: "DE98 ZZZ 0999 9999 999" }).sepaCreditorId).toBe("DE98ZZZ09999999999");
  });
  it("lehnt falsche Prüfziffer ab", () => {
    const r = organizationSchema.safeParse({ ...org, sepaCreditorId: "DE97ZZZ09999999999" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("Ungültige Gläubiger-ID (Format oder Prüfziffer).");
  });
});

describe("directDebitSnapshotSchema", () => {
  it("parst ein Beispiel", () => {
    const v = { creditorId: "DE98ZZZ09999999999", mandateReference: "M-1", mandateSignedAt: "2026-01-15", debtorIban: "DE89370400440532013000", debtorAccountName: null };
    expect(directDebitSnapshotSchema.parse(v)).toEqual(v);
  });
});
