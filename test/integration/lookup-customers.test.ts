/** Phase 22a T4 — Kunden-/Produkt-Lookup und Editor-Kontext. Org-Scope, Archiv, Praefix-Rang. */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { lookupCustomers, loadCustomerForEditor } from "@/domain/customer/lookup";
import { lookupProducts } from "@/domain/product/lookup";
import { formatAddressLabel, formatContactLabel } from "@/domain/customer/editor-labels";
import { NotFoundError } from "@/domain/errors";

let orgA: string;
let orgB: string;
let foreignId: string;
let beckerId: string;
let archivedId: string;

const base = { addressLine1: "Lookupweg 1", postalCode: "10955", city: "Essen", type: "BUSINESS" };

beforeAll(async () => {
  orgA = (await dbInternal.organization.create({ data: { legalName: "Lookup A GmbH", addressLine1: "Lookupweg 1", postalCode: "10955", city: "Berlin" } })).id;
  orgB = (await dbInternal.organization.create({ data: { legalName: "Lookup B GmbH", addressLine1: "Lookupweg 2", postalCode: "10955", city: "Berlin" } })).id;
  await dbInternal.customer.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ orgId: orgA, name: `Kunde ${String(i).padStart(2, "0")}`, ...base })) });
  await dbInternal.customer.create({ data: { orgId: orgA, name: "Abele-Berg", ...base } });
  beckerId = (await dbInternal.customer.create({ data: { orgId: orgA, name: "Becker GmbH", customerNumber: "KD-L1", notes: "intern", datevAccount: 10001, ...base } })).id;
  await dbInternal.customer.create({ data: { orgId: orgA, name: "Mueller AG", ...base } });
  archivedId = (await dbInternal.customer.create({ data: { orgId: orgA, name: "Becker Archiv", isArchived: true, ...base } })).id;
  foreignId = (await dbInternal.customer.create({ data: { orgId: orgB, name: "Becker Fremd", ...base } })).id;
  await dbInternal.contactPerson.create({ data: { orgId: orgA, customerId: beckerId, firstName: "Anna", lastName: "Alt", role: "Einkauf", isDefault: true } });
  await dbInternal.customerAddress.create({ data: { orgId: orgA, customerId: beckerId, type: "SHIPPING", label: "Lager", addressLine1: "Hafen 3", postalCode: "20457", city: "Hamburg", countryCode: "DE" } });
  await dbInternal.contactPerson.create({ data: { orgId: orgB, customerId: foreignId, firstName: "Fritz", lastName: "Fremd", isDefault: true } });
  await dbInternal.product.createMany({
    data: [
      { orgId: orgA, name: "Beratung", unit: "HUR", netPriceCents: 9000, taxRate: 19, articleNumber: "ART-77" },
      { orgId: orgA, name: "Alt", unit: "C62", netPriceCents: 100, taxRate: 19, isArchived: true },
      { orgId: orgB, name: "Beratung Fremd", unit: "HUR", netPriceCents: 1, taxRate: 19 },
    ],
  });
});

describe("lookupCustomers", () => {
  it("Praefix vor Teiltreffer, kein Archiv, keine fremde Org", async () => {
    const r = await lookupCustomers(orgA, { q: "be" });
    expect(r.map((x) => x.name)).toEqual(["Becker GmbH", "Abele-Berg"]);
  });
  it("limit begrenzt, leeres q sortiert nach Name", async () => {
    const r = await lookupCustomers(orgA, { q: "", limit: "5" });
    expect(r).toHaveLength(5);
    expect(r[0]?.name).toBe("Abele-Berg");
  });
  it("ids: nur eigene aktive Kunden", async () => {
    const r = await lookupCustomers(orgA, { ids: `${foreignId},${archivedId},${beckerId}` });
    expect(r.map((x) => x.id)).toEqual([beckerId]);
  });
  it("liefert genau die Schluessel id, name, customerNumber, city, email", async () => {
    const [row] = await lookupCustomers(orgA, { q: "Becker GmbH" });
    expect(Object.keys(row ?? {}).sort()).toEqual(["city", "customerNumber", "email", "id", "name"]);
  });
  it("lehnt zu langes q und limit > 20 ab", async () => {
    await expect(lookupCustomers(orgA, { q: "x".repeat(101) })).rejects.toThrow();
    await expect(lookupCustomers(orgA, { limit: "50" })).rejects.toThrow();
  });
});

describe("loadCustomerForEditor", () => {
  it("liefert Kontakte und Adressen nur dieses Kunden mit den Seiten-Labels", async () => {
    const r = await loadCustomerForEditor(orgA, beckerId);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0]?.name).toBe(formatContactLabel({ firstName: "Anna", lastName: "Alt", role: "Einkauf" }));
    expect(r.addresses[0]?.label).toBe(formatAddressLabel({ label: "Lager", addressLine1: "Hafen 3", postalCode: "20457", city: "Hamburg" }));
    expect(r.addresses[0]?.label).toBe("Lager — Hafen 3, 20457 Hamburg");
    expect(r.customer).not.toHaveProperty("notes");
    expect(r.customer).not.toHaveProperty("datevAccount");
  });
  it("fremde Org und unbekannte Id -> NotFoundError", async () => {
    await expect(loadCustomerForEditor(orgA, foreignId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(loadCustomerForEditor(orgA, "gibt-es-nicht")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("lookupProducts", () => {
  it("nur aktive eigene Produkte, Suche ueber Name und Artikelnummer, feste Schluessel", async () => {
    const byName = await lookupProducts(orgA, { q: "berat" });
    expect(byName.map((p) => p.name)).toEqual(["Beratung"]);
    const byNo = await lookupProducts(orgA, { q: "ART-77" });
    expect(byNo).toHaveLength(1);
    expect(Object.keys(byNo[0] ?? {}).sort()).toEqual(["articleNumber", "id", "name", "netPriceCents", "taxRate", "unit"]);
    expect((await lookupProducts(orgA, { q: "Alt" })).length).toBe(0);
  });
});
