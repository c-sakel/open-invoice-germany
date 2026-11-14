/**
 * Phase 18f, Task 1 — Schema: Milli-Cent-Preise, Leistungszeitraum, Abrechnungsart, RecurringUsage.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";

const PREFIX = "V18F1-";
let orgId = "";
let customerId = "";
let recurringId = "";
let lineId = "";

function usage(externalId: string | null, extra: { recurringLineId?: string | null; invoiceId?: string | null } = {}) {
  const d = new Date("2185-02-01T00:00:00Z");
  return {
    orgId, recurringInvoiceId: recurringId, usageDate: d, periodStart: d, periodEnd: d,
    quantityMilli: 2500, source: "API", externalId, createdBy: "test", ...extra,
  };
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: `${PREFIX}Org GmbH`, addressLine1: "Weg 1", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  orgId = org.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: `${PREFIX}Kunde`, addressLine1: "Weg 2", postalCode: "12345", city: "Teststadt" },
    select: { id: true },
  });
  customerId = customer.id;
  const rec = await dbInternal.recurringInvoice.create({
    data: { orgId, customerId, title: `${PREFIX}Abo`, startDate: new Date(), nextRunDate: new Date() },
    select: { id: true },
  });
  recurringId = rec.id;
  const line = await dbInternal.recurringInvoiceLine.create({
    data: { recurringInvoiceId: recurringId, position: 1, description: "Altposition", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19 },
    select: { id: true, billing: true, usageUnitLabel: true, unitNetPriceMilliCents: true },
  });
  lineId = line.id;
  expect(line).toMatchObject({ billing: "FIXED", usageUnitLabel: null, unitNetPriceMilliCents: null });
});

describe("Schema Phase 18f", () => {
  it("Rechnungs- und Angebotszeile nur mit Altfeldern: neue Felder null", async () => {
    const inv = await dbInternal.invoice.create({ data: { orgId, customerId }, select: { id: true } });
    const il = await dbInternal.invoiceLine.create({
      data: { invoiceId: inv.id, position: 1, description: "Alt", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19, lineNetCents: 1000 },
      select: { unitNetPriceMilliCents: true, servicePeriodStart: true, servicePeriodEnd: true },
    });
    expect(il).toEqual({ unitNetPriceMilliCents: null, servicePeriodStart: null, servicePeriodEnd: null });
    const q = await dbInternal.quote.create({ data: { orgId, customerId }, select: { id: true } });
    const ql = await dbInternal.quoteLine.create({
      data: { quoteId: q.id, position: 1, description: "Alt", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19, lineNetCents: 1000 },
      select: { unitNetPriceMilliCents: true },
    });
    expect(ql.unitNetPriceMilliCents).toBeNull();
  });

  it("externalId ist je Abo eindeutig, mehrere ohne externalId erlaubt", async () => {
    await dbInternal.recurringUsage.create({ data: usage("ev-1", { recurringLineId: lineId }) });
    await expect(dbInternal.recurringUsage.create({ data: usage("ev-1") })).rejects.toMatchObject({ code: "P2002" });
    await dbInternal.recurringUsage.create({ data: usage(null) });
    await dbInternal.recurringUsage.create({ data: usage(null) });
  });

  it("Entwurfsrechnung loeschen setzt invoiceId NULL", async () => {
    const inv = await dbInternal.invoice.create({ data: { orgId, customerId }, select: { id: true } });
    const u = await dbInternal.recurringUsage.create({ data: usage("ev-draft", { invoiceId: inv.id }), select: { id: true } });
    await dbInternal.invoice.delete({ where: { id: inv.id } });
    const after = await dbInternal.recurringUsage.findUniqueOrThrow({ where: { id: u.id }, select: { invoiceId: true } });
    expect(after.invoiceId).toBeNull();
  });

  it("Abo-Zeile loeschen setzt recurringLineId NULL", async () => {
    const l = await dbInternal.recurringInvoiceLine.create({
      data: { recurringInvoiceId: recurringId, position: 2, description: "Temp", quantityMilli: 1000, unitNetPriceCents: 1, taxRate: 19, billing: "USAGE", usageUnitLabel: "API-Aufrufe", unitNetPriceMilliCents: 250 },
      select: { id: true },
    });
    const u = await dbInternal.recurringUsage.create({ data: usage("ev-line", { recurringLineId: l.id }), select: { id: true } });
    await dbInternal.recurringInvoiceLine.delete({ where: { id: l.id } });
    const after = await dbInternal.recurringUsage.findUniqueOrThrow({ where: { id: u.id }, select: { recurringLineId: true } });
    expect(after.recurringLineId).toBeNull();
  });

  it("Abo mit Verbrauchssaetzen ist nicht loeschbar (RESTRICT)", async () => {
    await expect(dbInternal.recurringInvoice.delete({ where: { id: recurringId } })).rejects.toThrow();
  });
});
