import { describe, it, expect } from "vitest";
import { sellerSnapshotSchema, buyerSnapshotSchema } from "@/schemas";
import { buildSellerSnapshot, buildBuyerSnapshot, parseSellerSnapshot, parseBuyerSnapshot } from "@/domain/snapshot";

const org = {
  legalName: "Muster GmbH", addressLine1: "Weg 1", addressLine2: null, postalCode: "12345", city: "Ort",
  country: "DE", vatId: "DE123456789", taxNumber: null, email: "a@b.de", phone: null,
  electronicAddress: null, iban: "DE00", bic: null, bankName: null,
};
const customer = {
  name: "Kunde AG", contactName: "Frau X", addressLine1: "Str. 2", addressLine2: null, postalCode: "54321",
  city: "Stadt", countryCode: "DE", vatId: null, email: "k@x.de", leitwegId: null,
};

describe("Snapshot-Builder und -Schemas", () => {
  it("Builder-Ausgabe besteht das Zod-Schema", () => {
    expect(sellerSnapshotSchema.safeParse(buildSellerSnapshot(org)).success).toBe(true);
    expect(buyerSnapshotSchema.safeParse(buildBuyerSnapshot(customer)).success).toBe(true);
  });

  it("Schluesselmengen entsprechen exakt den Mapper-Eingaben", () => {
    expect(Object.keys(buildSellerSnapshot(org)).sort()).toEqual(Object.keys(org).sort());
    expect(Object.keys(buildBuyerSnapshot(customer)).sort()).toEqual(Object.keys(customer).sort());
  });

  it("parse bevorzugt einen gueltigen Snapshot", () => {
    const json = JSON.stringify({ ...buildSellerSnapshot(org), legalName: "Alt GmbH" });
    expect(parseSellerSnapshot(json, org, "inv-1").legalName).toBe("Alt GmbH");
  });

  it("parse faellt bei ungueltigem Snapshot auf die Relation zurueck", () => {
    expect(parseSellerSnapshot("{nicht json", org, "inv-1")).toEqual(org);
    expect(parseBuyerSnapshot(JSON.stringify({ name: 1 }), customer, "inv-1")).toEqual(customer);
    expect(parseBuyerSnapshot(null, customer, "inv-1")).toEqual(customer);
  });
});
