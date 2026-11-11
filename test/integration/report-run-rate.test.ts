/** Phase 16f, Task 5 — recurringRunRate. Eigenes Jahr 2107 (Startdaten). */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { recurringRunRate } from "@/domain/reporting/recurring-run-rate";

const START = new Date(Date.UTC(2107, 0, 1));

async function mkOrg(name: string) {
  const o = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "R 1", postalCode: "10115", city: "Berlin", vatId: "DE844444444", taxNumber: "84/444/44444" } });
  const c = await dbInternal.customer.create({ data: { orgId: o.id, name: "Kunde", addressLine1: "A 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } });
  return { orgId: o.id, customerId: c.id };
}
async function sub(o: { orgId: string; customerId: string }, p: { status?: string; interval?: string; intervalCount?: number; currency?: string; cents: number }) {
  return dbInternal.recurringInvoice.create({
    data: {
      orgId: o.orgId, customerId: o.customerId, title: "Abo", status: p.status ?? "ACTIVE", interval: p.interval ?? "MONTHLY",
      intervalCount: p.intervalCount ?? 1, startDate: START, nextRunDate: START, currency: p.currency ?? "EUR",
      lines: { create: [{ position: 1, description: "Wartung", quantityMilli: 1000, unitNetPriceCents: p.cents, taxRate: 19 }] },
    },
  });
}

describe("recurringRunRate", () => {
  it("PAUSED/ENDED ausgeschlossen", async () => {
    const o = await mkOrg("Run A GmbH");
    await sub(o, { cents: 10000 });
    await sub(o, { cents: 5000, status: "PAUSED" });
    await sub(o, { cents: 5000, status: "ENDED" });
    expect(await recurringRunRate(o.orgId)).toEqual([{ currency: "EUR", monthlyNetCents: 10000, activeCount: 1 }]);
  });

  it("Summe je Währung", async () => {
    const o = await mkOrg("Run B GmbH");
    await sub(o, { cents: 10000 });
    await sub(o, { cents: 120000, interval: "YEARLY" });
    await sub(o, { cents: 3000, currency: "USD" });
    expect(await recurringRunRate(o.orgId)).toEqual([
      { currency: "EUR", monthlyNetCents: 20000, activeCount: 2 },
      { currency: "USD", monthlyNetCents: 3000, activeCount: 1 },
    ]);
  });

  it("fremde Org unsichtbar", async () => {
    const o = await mkOrg("Run C GmbH");
    const other = await mkOrg("Run D GmbH");
    await sub(o, { cents: 10000 });
    expect(await recurringRunRate(other.orgId)).toEqual([]);
  });
});
