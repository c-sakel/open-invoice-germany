/**
 * Zinsende und neue Zahlungsfrist der Mahnung nach Berliner Kalendertag. Testjahr 2311.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createDunning } from "@/domain/dunning/create";
import { upsertBaseRate, loadBaseRates } from "@/domain/dunning/base-rate";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { computeInterestSegments } from "@/lib/dunning";
import { listDunningStages, updateDunningStage } from "@/domain/dunning/stages";
import type { CreateInvoiceInput } from "@/schemas";

const U = (m: number, d: number, h = 12, min = 0) => new Date(Date.UTC(2311, m - 1, d, h, min));
const iso = (d: Date) => d.toISOString();

let orgId = "";
let n = 0;
let newDueDays = 0;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Berlintag Test GmbH", addressLine1: "Teststr. 1", postalCode: "12345", city: "Berlin", vatId: "DE999999999", taxNumber: "1" },
  });
  orgId = org.id;
  orgStore.id = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await upsertBaseRate(orgId, { validFrom: "2311-01-01", rateBp: 200, source: "Test" });
  const s0 = (await listDunningStages(orgId)).find((s) => s.order === 0)!;
  const { id, ...rest } = s0;
  void id;
  await updateDunningStage(orgId, s0.id, { ...rest, calculateInterest: true });
  newDueDays = s0.newDueDays;
});

async function overdueInvoice() {
  n += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `Berlintag ${n}`, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const draft = await createDraftInvoice(orgId, {
    customerId: c.id,
    type: "INVOICE",
    taxScheme: "REGULAR",
    currency: "EUR",
    deliveryDate: U(1, 2),
    dueDate: U(1, 5, 0),
    lines: [{ description: "Beratung", quantityMilli: 2000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
  } as CreateInvoiceInput);
  const fin = await finalizeInvoice(draft.id, { now: U(1, 2) });
  await dbInternal.emailLog.create({ data: { orgId, docType: "INVOICE", docId: fin.id, subject: "x", bodySnapshot: "x", status: "SENT", sentAt: U(1, 3) } });
  return fin;
}

async function interestTo(invoiceGross: number, from: Date, to: Date) {
  const rates = await loadBaseRates(dbInternal, orgId);
  return computeInterestSegments({ openAmountCents: invoiceGross, from, to, isConsumer: false, rates }).interestCents;
}

describe("Mahnung nach Berliner Kalendertag", () => {
  it("23:30 UTC (Berlin 00:30 am Folgetag): ein Zinstag mehr als um 12:00 UTC, Frist ab Berliner Tag", async () => {
    const a = await overdueInvoice();
    const b = await overdueInvoice();
    const late = await createDunning(a.id, { now: U(3, 10, 23, 30), force: true });
    const noon = await createDunning(b.id, { now: U(3, 11, 12), force: true });
    expect(late.dunning.interestFrom).not.toBeNull();
    const from = late.dunning.interestFrom!;
    expect(late.dunning.interestAmountCents).toBe(await interestTo(a.grossTotalCents, from, U(3, 11, 0)));
    expect(late.dunning.interestAmountCents).toBe(noon.dunning.interestAmountCents);
    expect(late.dunning.interestAmountCents).toBeGreaterThan(await interestTo(a.grossTotalCents, from, U(3, 10, 0)));
    expect(iso(late.dunning.dueDate!)).toBe(iso(new Date(Date.UTC(2311, 2, 11 + newDueDays))));
    expect(iso(noon.dunning.dueDate!)).toBe(iso(late.dunning.dueDate!));
  });

  it("12:00 UTC bleibt unveraendert (Regression)", async () => {
    const a = await overdueInvoice();
    const r = await createDunning(a.id, { now: U(3, 20, 12), force: true });
    expect(r.dunning.interestAmountCents).toBe(await interestTo(a.grossTotalCents, r.dunning.interestFrom!, U(3, 20, 0)));
    expect(iso(r.dunning.dueDate!)).toBe(iso(new Date(Date.UTC(2311, 2, 20 + newDueDays))));
  });

  it("Sommerzeit: 22:30 UTC am 10.07. ist Berliner 11.07.", async () => {
    const a = await overdueInvoice();
    const r = await createDunning(a.id, { now: U(7, 10, 22, 30), force: true });
    expect(iso(r.dunning.dueDate!)).toBe(iso(new Date(Date.UTC(2311, 6, 11 + newDueDays))));
    expect(r.dunning.interestAmountCents).toBe(await interestTo(a.grossTotalCents, r.dunning.interestFrom!, U(7, 11, 0)));
  });
});
