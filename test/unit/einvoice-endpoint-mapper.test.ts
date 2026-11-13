/**
 * Phase 17a — Mapper: BT-49 (Erwerber-Endpunkt), BT-47 (legalRegistrationId) und BT-34 (Verkaeufer-Endpunkt)
 * aus Snapshot bzw. Live-Relation.
 */
import { describe, it, expect } from "vitest";
import { buildEInvoiceData, type MapInput } from "@/lib/einvoice/mapper";

const ORG: MapInput["org"] = {
  legalName: "Test GmbH", addressLine1: "Hauptstr. 1", addressLine2: null, postalCode: "21339", city: "Lüneburg", country: "DE",
  vatId: "DE123456789", taxNumber: null, email: "info@test.de", phone: null, electronicAddress: null, electronicAddressScheme: null,
  iban: null, bic: null, bankName: null, accountHolder: null,
};
const CUSTOMER: MapInput["customer"] = {
  name: "Kunde AG", contactName: null, addressLine1: "Marktplatz 2", addressLine2: null, postalCode: "20095", city: "Hamburg",
  countryCode: "DE", vatId: null, email: "live@kunde.de", leitwegId: null, peppolId: "9876543210123", peppolScheme: "0088",
};
const BUYER_BASE = {
  name: "Kunde AG", contactName: null, addressLine1: "Marktplatz 2", addressLine2: null, postalCode: "20095", city: "Hamburg",
  countryCode: "DE", vatId: null, email: "snap@kunde.de", leitwegId: null,
};
const SELLER_BASE = {
  legalName: "Test GmbH", addressLine1: "Hauptstr. 1", addressLine2: null, postalCode: "21339", city: "Lüneburg", country: "DE",
  vatId: "DE123456789", taxNumber: null, email: "info@test.de", phone: null, electronicAddress: "rechnung@test.de",
  iban: null, bic: null, bankName: null, accountHolder: null,
};

function input(overrides: Partial<MapInput> = {}): MapInput {
  return {
    number: "RE-2040-0001", type: "INVOICE", issueDate: new Date("2040-04-01"), dueDate: null, deliveryDate: new Date("2040-04-01"),
    currency: "EUR", buyerReference: null, paymentTerms: null, notes: null,
    netTotalCents: 10000, taxTotalCents: 1900, grossTotalCents: 11900, paidAmountCents: 0,
    taxBreakdownJson: JSON.stringify([{ taxCategory: "S", taxRate: 19, netCents: 10000, taxCents: 1900 }]),
    org: ORG, customer: CUSTOMER,
    lines: [{ id: "1", description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, lineNetCents: 10000, taxRate: 19, taxCategory: "S" }],
    ...overrides,
  };
}

describe("buildEInvoiceData — Endpunkte (BT-49/BT-34) und BT-47", () => {
  it("Snapshot mit endpoint: wird uebernommen, nicht neu aufgeloest", () => {
    const snap = { ...BUYER_BASE, endpoint: { scheme: "0204", id: "04011000-12345-86" }, legalRegistrationId: "HRB 1234" };
    const d = buildEInvoiceData(input({ buyerSnapshotJson: JSON.stringify(snap) }));
    expect(d.buyer.endpoint).toEqual({ scheme: "0204", id: "04011000-12345-86" });
    expect(d.buyer.legalRegistrationId).toBe("HRB 1234");
  });

  it("Alt-Snapshot ohne endpoint-Schluessel: EM mit E-Mail des Snapshots (Live-Peppol-ID wird ignoriert)", () => {
    const d = buildEInvoiceData(input({ buyerSnapshotJson: JSON.stringify(BUYER_BASE) }));
    expect(d.buyer.endpoint).toEqual({ scheme: "EM", id: "snap@kunde.de" });
    expect(d.buyer.legalRegistrationId).toBeUndefined();
  });

  it("Entwurf/Live-Relation (kein Snapshot): resolveBuyerEndpoint, Peppol vor E-Mail", () => {
    const d = buildEInvoiceData(input({ buyerSnapshotJson: null }));
    expect(d.buyer.endpoint).toEqual({ scheme: "0088", id: "9876543210123" });
    const mail = buildEInvoiceData(input({ buyerSnapshotJson: null, customer: { ...CUSTOMER, peppolId: null, peppolScheme: null } }));
    expect(mail.buyer.endpoint).toEqual({ scheme: "EM", id: "live@kunde.de" });
  });

  it("Seller-Snapshot mit electronicAddressScheme: null -> EM; mit Schema -> Schema; Alt-Snapshot -> EM", () => {
    const em = buildEInvoiceData(input({ sellerSnapshotJson: JSON.stringify({ ...SELLER_BASE, electronicAddressScheme: null }) }));
    expect(em.seller.endpoint).toEqual({ scheme: "EM", id: "rechnung@test.de" });
    const gln = buildEInvoiceData(input({ sellerSnapshotJson: JSON.stringify({ ...SELLER_BASE, electronicAddressScheme: "0088" }) }));
    expect(gln.seller.endpoint).toEqual({ scheme: "0088", id: "rechnung@test.de" });
    const legacy = buildEInvoiceData(input({ sellerSnapshotJson: JSON.stringify(SELLER_BASE) }));
    expect(legacy.seller.endpoint).toEqual({ scheme: "EM", id: "rechnung@test.de" });
  });

  it("Storno/Teilgutschrift mit uebernommenem Snapshot behalten endpoint und legalRegistrationId", () => {
    const buyer = JSON.stringify({ ...BUYER_BASE, endpoint: { scheme: "0204", id: "04011000-12345-86" }, legalRegistrationId: "HRB 1234" });
    const seller = JSON.stringify({ ...SELLER_BASE, electronicAddressScheme: "0088" });
    {
      const d = buildEInvoiceData(input({ type: "CREDIT_NOTE", buyerSnapshotJson: buyer, sellerSnapshotJson: seller }));
      expect(d.buyer.endpoint).toEqual({ scheme: "0204", id: "04011000-12345-86" });
      expect(d.buyer.legalRegistrationId).toBe("HRB 1234");
      expect(d.seller.endpoint).toEqual({ scheme: "0088", id: "rechnung@test.de" });
    }
  });
});
