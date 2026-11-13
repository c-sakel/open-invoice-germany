/**
 * Phase 17a Task 5: Ausfuhrpruefung nach Bestimmungsort (Lieferanschrift am Beleg) und
 * Rechnungsanschrift am Beleg statt Kundenstamm. Eigenes Testjahr 2140.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { finalizeInvoice, FinalizeError } from "@/domain/invoice/finalize";

const NOW = new Date("2140-05-01T10:00:00.000Z");
let orgId: string;
let seq = 0;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Bestimmungsort GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE555666777", taxNumber: "33/333/33333" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
});

async function draft(opts: { stammCountry: string; scheme: string; notes: string; category: string; shipping?: string; billing?: string }) {
  seq += 1;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: `Kunde ${seq}`, addressLine1: "Weg 1", postalCode: "20095", city: "Ort", type: "BUSINESS", countryCode: opts.stammCountry },
  });
  const addr = async (type: "BILLING" | "SHIPPING", countryCode: string) =>
    (await dbInternal.customerAddress.create({ data: { orgId, customerId: customer.id, type, addressLine1: "Adresse 1", postalCode: "12345", city: "Stadt", countryCode } })).id;
  return dbInternal.invoice.create({
    data: {
      orgId,
      customerId: customer.id,
      type: "INVOICE",
      status: "DRAFT",
      taxScheme: opts.scheme,
      issueDate: NOW,
      deliveryDate: NOW,
      notes: opts.notes,
      billingAddressId: opts.billing ? await addr("BILLING", opts.billing) : null,
      shippingAddressId: opts.shipping ? await addr("SHIPPING", opts.shipping) : null,
      lines: { create: [{ position: 1, description: "Ware", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 0, taxCategory: opts.category, lineNetCents: 10000 }] },
    },
  });
}

describe("Ausfuhr nach Bestimmungsort", () => {
  const ausfuhr = { scheme: "AUSFUHR", notes: "Steuerfreie Ausfuhrlieferung", category: "G" };

  it("Kunde DE, Lieferanschrift CH: festschreibbar", async () => {
    const inv = await draft({ stammCountry: "DE", shipping: "CH", ...ausfuhr });
    const res = await finalizeInvoice(inv.id, { now: NOW });
    expect(res.status).toBe("FINALIZED");
  });

  it("Kunde CH, Lieferanschrift DE: blockiert", async () => {
    const inv = await draft({ stammCountry: "CH", shipping: "DE", ...ausfuhr });
    await expect(finalizeInvoice(inv.id, { now: NOW })).rejects.toThrow(FinalizeError);
    await expect(finalizeInvoice(inv.id, { now: NOW })).rejects.toThrow(/Bestimmungsort/);
  });

  it("Rechnungsadresse US am Beleg bei Stamm-DE und NICHT_STEUERBAR: ok", async () => {
    const inv = await draft({
      stammCountry: "DE",
      billing: "US",
      scheme: "NICHT_STEUERBAR",
      notes: "Nicht im Inland steuerbare Leistung (Leistungsort außerhalb Deutschlands, § 3a UStG)",
      category: "O",
    });
    const res = await finalizeInvoice(inv.id, { now: NOW });
    expect(res.status).toBe("FINALIZED");
  });
});
