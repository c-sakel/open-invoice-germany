/**
 * Sammelrechnung: Schema-Spalten (Abo-Schalter, Blockueberschrift, Herkunft je Position).
 * Nur Entwuerfe, keine Belegnummer vergeben.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";

let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Sammel Schema GmbH", addressLine1: "Weg 1", postalCode: "99901", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Schema Kunde", addressLine1: "Kundenweg 1", postalCode: "99901", city: "Teststadt", countryCode: "DE" },
    select: { id: true },
  });
  customerId = c.id;
});

async function makeRecurring(title: string) {
  return dbInternal.recurringInvoice.create({
    data: { orgId, customerId, title, startDate: new Date("2205-01-01"), nextRunDate: new Date("2205-01-01") },
    select: { id: true, collectiveBilling: true, invoiceHeading: true },
  });
}

async function makeDraft() {
  return dbInternal.invoice.create({
    data: { orgId, customerId, status: "DRAFT" },
    select: { id: true },
  });
}

describe("Sammelrechnung-Schema", () => {
  it("Abo ohne Angabe: collectiveBilling false, invoiceHeading null", async () => {
    const r = await makeRecurring("Standard");
    expect(r.collectiveBilling).toBe(false);
    expect(r.invoiceHeading).toBeNull();
  });

  it("Position ohne Angabe hat keine Abo-Herkunft, beliebige Abo-Id ist speicherbar (kein Fremdschluessel)", async () => {
    const inv = await makeDraft();
    const base = { invoiceId: inv.id, quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19, lineNetCents: 100 };
    const a = await dbInternal.invoiceLine.create({
      data: { ...base, position: 1, description: "Ohne" },
      select: { recurringInvoiceId: true },
    });
    expect(a.recurringInvoiceId).toBeNull();
    const b = await dbInternal.invoiceLine.create({
      data: { ...base, position: 2, description: "Mit", recurringInvoiceId: "gibt-es-nicht" },
      select: { recurringInvoiceId: true },
    });
    expect(b.recurringInvoiceId).toBe("gibt-es-nicht");
  });

  it("Abo loeschen laesst die Positionsherkunft anderer Belege unberuehrt", async () => {
    const r = await makeRecurring("Wird geloescht");
    const inv = await makeDraft();
    const line = await dbInternal.invoiceLine.create({
      data: { invoiceId: inv.id, position: 1, description: "Herkunft", quantityMilli: 1000, unitNetPriceCents: 100, taxRate: 19, lineNetCents: 100, recurringInvoiceId: r.id },
      select: { id: true },
    });
    await dbInternal.recurringInvoice.delete({ where: { id: r.id } });
    const after = await dbInternal.invoiceLine.findUniqueOrThrow({ where: { id: line.id }, select: { recurringInvoiceId: true } });
    expect(after.recurringInvoiceId).toBe(r.id);
  });
});
