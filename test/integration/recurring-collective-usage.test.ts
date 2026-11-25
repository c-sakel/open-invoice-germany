/**
 * Sammelrechnung mit Verbrauchsabos: Gruppe wird erst am Berliner Folgetag abgerechnet,
 * leere Verbrauchsperioden, Storno, Idempotenz, maxRuns mit offenem Verbrauch. Eigenes Jahr 2206.
 */
import { createBestandRecurring } from "../helpers/recurring-bestand";
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { emitRecurringNow, runDueRecurring, isSkipped, type EmittedInvoice } from "@/domain/recurring/run";
import { RecurringNotDueError } from "@/domain/recurring/errors";
import { recordUsage, UsageError } from "@/domain/recurring/usage";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createRecurringSchema } from "@/schemas";

const START = "2206-03-01T10:00:00.000Z";
const DAY = 86_400_000;
let orgId: string;
let seq = 0;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Sammel Verbrauch GmbH", addressLine1: "Weg 4", postalCode: "99904", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" },
    select: { id: true },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
});

async function customer(): Promise<string> {
  seq += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `Verbrauchskunde ${seq}`, addressLine1: "Kundenweg 4", postalCode: "99904", city: "Teststadt", countryCode: "DE", type: "BUSINESS" },
    select: { id: true },
  });
  return c.id;
}

const base = { quantityMilli: 1000, unit: "C62", taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const fixed = (d: string, cents: number) => ({ lineType: "ITEM", description: d, unitNetPriceCents: cents, ...base });
const usageLine = { lineType: "ITEM", description: "Verbrauch", quantityMilli: 0, unit: "C62", unitNetPriceCents: 0, unitNetPriceMilliCents: 200, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, billing: "USAGE", usageUnitLabel: "Stk" };

async function abo(customerId: string, title: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return createBestandRecurring(orgId, createRecurringSchema.parse({ customerId, title, startDate: START, collectiveBilling: true, invoiceHeading: `Block ${title}`, autoFinalize: true, lines, ...extra }));
}

async function addUsage(rec: { id: string; lines: { id: string; billing: string }[] }, q: number, day = "2206-03-01") {
  const lineId = rec.lines.find((l) => l.billing === "USAGE")!.id;
  await recordUsage(orgId, rec.id, { recurringLineId: lineId, quantityMilli: q, usageDate: day }, { source: "API", actor: "t", now: new Date("2206-03-02T10:00:00Z") });
}

function only(emitted: EmittedInvoice[]): EmittedInvoice {
  expect(emitted).toHaveLength(1);
  return emitted[0];
}

describe("Sammelrechnung mit Verbrauch", () => {
  it("Gruppe mit Verbrauchsabo wird am Stichtag zurueckgestellt und am Folgetag gemeinsam abgerechnet", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [usageLine]);
    await addUsage(b, 5000);
    const day = await runDueRecurring({ now: a.nextRunDate, orgId });
    const sums = day.filter((s) => [a.id, b.id].includes(s.recurringId));
    expect(sums.flatMap((s) => s.emitted)).toHaveLength(0);
    expect(sums.some((s) => s.deferred)).toBe(true);
    expect(await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: a.id }, select: { issuedCount: true } })).toEqual({ issuedCount: 0 });

    const next = await runDueRecurring({ now: new Date(a.nextRunDate.getTime() + DAY), orgId });
    const out = only(next.filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted));
    expect(out.collectiveRecurringIds).toEqual([a.id, b.id].sort());
    const lines = await dbInternal.invoiceLine.findMany({ where: { invoiceId: out.invoiceId, lineType: "ITEM" }, orderBy: { position: "asc" }, select: { recurringInvoiceId: true, servicePeriodStart: true } });
    expect(lines.find((l) => l.recurringInvoiceId === b.id)?.servicePeriodStart).not.toBeNull();
    const u = await dbInternal.recurringUsage.findFirstOrThrow({ where: { recurringInvoiceId: b.id }, select: { invoiceId: true } });
    expect(u.invoiceId).toBe(out.invoiceId);
  });

  it("emitRecurringNow(A) am Stichtag mit Verbrauchspartner: B bleibt ausserhalb der Gruppe, A einzeln", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [usageLine]);
    await addUsage(b, 100);
    const out = await emitRecurringNow(a.id, { now: a.nextRunDate });
    expect("invoiceId" in out && out.collectiveRecurringIds).toBeFalsy();
    expect(await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: a.id }, select: { issuedCount: true } })).toEqual({ issuedCount: 1 });
    expect(await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: b.id }, select: { issuedCount: true } })).toEqual({ issuedCount: 0 });
    expect(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: b.id, invoiceId: null } })).toBe(1);
  });

  it("emitRecurringNow(B) am Stichtag, B ist das nicht faellige Verbrauchsabo -> RecurringNotDueError, nichts geschrieben", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [usageLine]);
    await addUsage(b, 100);
    await expect(emitRecurringNow(b.id, { now: a.nextRunDate })).rejects.toBeInstanceOf(RecurringNotDueError);
    expect(await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: a.id }, select: { issuedCount: true } })).toEqual({ issuedCount: 0 });
  });

  it("Mitglied spaeter am selben Tag faellig: Gruppe wird zurueckgestellt und laeuft am selben Tag nach", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [fixed("Fest 2", 2000)]);
    await dbInternal.recurringInvoice.update({ where: { id: b.id }, data: { nextRunDate: new Date(a.nextRunDate.getTime() + 3 * 3_600_000) } });
    const early = await runDueRecurring({ now: a.nextRunDate, orgId });
    expect(early.filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted)).toHaveLength(0);
    const later = await runDueRecurring({ now: new Date(a.nextRunDate.getTime() + 4 * 3_600_000), orgId });
    const out = only(later.filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted));
    expect(out.collectiveRecurringIds).toEqual([a.id, b.id].sort());
  });

  it("Verbrauchspartner ohne Verbrauch: Einzelform fuer A, B rueckt ohne Zaehler vor; beide leer -> uebersprungen", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [usageLine]);
    const out = only((await runDueRecurring({ now: new Date(a.nextRunDate.getTime() + DAY), orgId })).filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted));
    expect(out.collectiveRecurringIds).toBeUndefined();
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: out.invoiceId }, select: { recurringInvoiceId: true } });
    expect(inv.recurringInvoiceId).toBe(a.id);
    const bAfter = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: b.id }, select: { issuedCount: true, nextRunDate: true } });
    expect(bAfter.issuedCount).toBe(0);
    expect(bAfter.nextRunDate.getTime()).toBeGreaterThan(b.nextRunDate.getTime());
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: b.id, type: "USAGE_EMPTY_PERIOD" } })).toBe(1);

    const c2 = await customer();
    const u1 = await abo(c2, "U1", [usageLine]);
    const u2 = await abo(c2, "U2", [usageLine]);
    const res = await emitRecurringNow(u1.id, { now: new Date(u1.nextRunDate.getTime() + DAY) });
    expect(isSkipped(res)).toBe(true);
    expect(await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: u2.id }, select: { issuedCount: true } })).toEqual({ issuedCount: 0 });
  });

  it("Storno der Sammelrechnung: Verbrauch bleibt abgerechnet und wird nicht erneut berechnet", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [usageLine]);
    await addUsage(b, 7000);
    const now = new Date(a.nextRunDate.getTime() + DAY);
    const out = only((await runDueRecurring({ now, orgId })).filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted));
    await cancelInvoice(out.invoiceId, { orgId, actor: "t", reason: "Test", now });
    expect(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: b.id, invoiceId: out.invoiceId } })).toBe(1);
    const later = new Date(now.getTime() + 32 * DAY);
    const sums = (await runDueRecurring({ now: later, orgId })).filter((s) => [a.id, b.id].includes(s.recurringId));
    for (const e of sums.flatMap((s) => s.emitted)) {
      const l = await dbInternal.invoiceLine.findMany({ where: { invoiceId: e.invoiceId, description: "Verbrauch" }, select: { id: true } });
      expect(l).toHaveLength(0);
    }
    expect(await dbInternal.recurringUsage.count({ where: { recurringInvoiceId: b.id, invoiceId: out.invoiceId } })).toBe(1);
  });

  it("Lauf zweimal mit gleichem now: eine Rechnung; Verbrauch fuer abgerechnete Periode -> PERIOD_BILLED", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [usageLine]);
    await addUsage(b, 300);
    const now = new Date(a.nextRunDate.getTime() + DAY);
    const first = (await runDueRecurring({ now, orgId })).filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted);
    const second = (await runDueRecurring({ now, orgId })).filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    await expect(addUsage(b, 1, "2206-03-01")).rejects.toMatchObject({ code: "PERIOD_BILLED" });
    expect(UsageError).toBeDefined();
  });

  it("maxRuns erreicht, Verbrauch nach Periodenende offen: B bleibt aktiv mit Hinweis", async () => {
    const c = await customer();
    const a = await abo(c, "A", [fixed("Fest", 1000)]);
    const b = await abo(c, "B", [usageLine], { maxRuns: 1 });
    await addUsage(b, 100);
    // Verbrauch nach dem Ende der abzurechnenden Periode (Stichtag 01.03.): direkt als offener Satz hinterlegt
    const lineId = b.lines.find((l) => l.billing === "USAGE")!.id;
    await dbInternal.recurringUsage.create({
      data: { orgId, recurringInvoiceId: b.id, recurringLineId: lineId, quantityMilli: 50, usageDate: new Date("2206-03-20T10:00:00Z"), periodStart: new Date("2206-03-02T10:00:00Z"), periodEnd: new Date("2206-04-01T10:00:00Z"), source: "API", createdBy: "t" },
    });
    const out = only((await runDueRecurring({ now: new Date(a.nextRunDate.getTime() + DAY), orgId })).filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted));
    expect(out.notice).toContain("maxRuns");
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: b.id }, select: { status: true } })).status).toBe("ACTIVE");
  });
});
