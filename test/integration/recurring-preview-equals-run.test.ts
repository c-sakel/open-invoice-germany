/** Vorschau und Lauf liefern denselben ersten Zeitraum (Verbrauchsabo ohne Ankertag, Start am 31.). Testjahr 2339. */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBestandRecurring } from "../helpers/recurring-bestand";
import { createRecurringSchema } from "@/schemas";
import { findPreviewBasis } from "@/domain/recurring/last-billed";
import { buildRunLines } from "@/domain/recurring/run-parts";
import { previewPeriods, type RecurInterval, type BillingTiming } from "@/lib/recurring";
import { berlinDateKey } from "@/lib/berlin-time";

const D = (iso: string): Date => new Date(`${iso}T10:00:00.000Z`);
const fixed = { lineType: "ITEM", description: "Grundgebuehr", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usage = { ...fixed, description: "Aufrufe", quantityMilli: 0, unitNetPriceCents: 0, unitNetPriceMilliCents: 200, billing: "USAGE", usageUnitLabel: "Aufrufe" };

let recId: string;

beforeAll(async () => {
  const orgId = (await dbInternal.organization.create({ data: { legalName: "Vorschau Lauf GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888997", taxNumber: "44/444/44446" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", countryCode: "DE", type: "BUSINESS" }, select: { id: true } })).id;
  const rec = await createBestandRecurring(orgId, createRecurringSchema.parse({ customerId, title: "Verbrauch", startDate: D("2339-01-31"), interval: "MONTHLY", billingTiming: "ARREARS", lines: [fixed, usage] }));
  recId = rec.id;
});

describe("Vorschau == Lauf", () => {
  it("erster Zeitraum eines Verbrauchsabos ohne Ankertag", async () => {
    const rec = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: recId }, include: { lines: true } });
    const basis = await findPreviewBasis(dbInternal, rec);
    const first = previewPeriods({
      previousEnd: basis.previousEnd, billingTiming: rec.billingTiming as BillingTiming, nextRunDate: rec.nextRunDate,
      interval: rec.interval as RecurInterval, intervalCount: rec.intervalCount, anchorDay: basis.anchorDay,
      endDate: rec.endDate, status: rec.status, maxRuns: rec.maxRuns, issuedCount: rec.issuedCount,
    }, 1)[0]!;
    const run = await buildRunLines(dbInternal, rec, rec.nextRunDate);
    expect(berlinDateKey(first.start)).toBe(berlinDateKey(run.period.start));
    expect(berlinDateKey(first.end)).toBe(berlinDateKey(run.period.end));
  });
});
