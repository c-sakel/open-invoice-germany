/**
 * Abo-Lauf mit Leistungszeitraum (22b T3): BG-14 + BG-26 an Kopf und Positionen, kein BT-72 (deliveryDate),
 * Kopftext je Belegsprache, Bestand (nachträglich), Verbrauch, endDate, Sammelrechnung, Nachholen,
 * Fremdwährung bei Vorausrechnung. Eigenes Jahr 2261, eigene Organisation.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createRecurring } from "@/domain/recurring/create";
import { emitRecurringNow, isSkipped, runDueRecurring } from "@/domain/recurring/run";
import { recordUsage } from "@/domain/recurring/usage";
import { upsertManualRate } from "@/domain/fx/store";
import { exchangeRateUpsertSchema } from "@/schemas/fx";
import { createRecurringSchema, type CreateRecurringInput } from "@/schemas";
import { createBestandRecurring } from "../helpers/recurring-bestand";

const D = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

let orgId: string;
let customerId: string;
let enCustomerId: string;
let usdCustomerId: string;
let seq = 0;

const item = (description: string, cents = 2900) => ({ lineType: "ITEM", description, quantityMilli: 1000, unit: "C62", unitNetPriceCents: cents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 });
const heading = { lineType: "HEADING", description: "Abschnitt", quantityMilli: 0, unitNetPriceCents: 0, taxRate: 0, taxCategory: "S", discountPermille: 0, discountCents: 0 };
const usageLine = { ...item("API-Aufrufe", 0), quantityMilli: 0, unitNetPriceMilliCents: 200, billing: "USAGE", usageUnitLabel: "Aufrufe" };

function input(extra: Record<string, unknown> = {}): CreateRecurringInput {
  seq += 1;
  return createRecurringSchema.parse({ customerId, title: `Abo ${seq}`, startDate: D("2261-11-25"), interval: "YEARLY", lines: [item("Hosting"), heading, item("Support", 1000)], autoFinalize: false, ...extra });
}

async function load(invoiceId: string) {
  return dbInternal.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { deliveryDate: true, deliveryStart: true, deliveryEnd: true, headerText: true, fxRateDate: true, issueDate: true, lines: { orderBy: { position: "asc" }, select: { lineType: true, description: true, servicePeriodStart: true, servicePeriodEnd: true } } },
  });
}

async function emit(recId: string, now: Date) {
  const out = await emitRecurringNow(recId, { now });
  if (isSkipped(out)) throw new Error("übersprungen");
  return out;
}

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  orgId = (await dbInternal.organization.create({ data: { legalName: "Zeitraum Lauf GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" } })).id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await dbInternal.documentSettings.upsert({ where: { orgId }, create: { orgId, fxRateSource: "BMF_MONTHLY" }, update: { fxRateSource: "BMF_MONTHLY" } });
  const base = { orgId, addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "kunde@example.org" };
  customerId = (await dbInternal.customer.create({ data: { ...base, name: "Laufkunde AG" } })).id;
  enCustomerId = (await dbInternal.customer.create({ data: { ...base, name: "Run Client Ltd", language: "en" } })).id;
  usdCustomerId = (await dbInternal.customer.create({ data: { ...base, name: "Dollar Client Inc", defaultCurrency: "USD" } })).id;
  await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2261-11-01", rate: "1,1214" }), "test", orgId);
});

describe("Einzelrechnung", () => {
  it("ADVANCE jährlich: BG-14 + BG-26 je ITEM, kein BT-72, Kopftext", async () => {
    const rec = await createRecurring(orgId, input());
    const out = await emit(rec.id, D("2261-11-25"));
    const inv = await load(out.invoiceId);
    expect(inv.deliveryDate).toBeNull();
    expect(iso(inv.deliveryStart)).toBe("2261-11-25");
    expect(iso(inv.deliveryEnd)).toBe("2262-11-24");
    expect(inv.headerText).toBe("Leistungszeitraum 25.11.2261 – 24.11.2262");
    for (const l of inv.lines) {
      if (l.lineType === "ITEM") {
        expect(iso(l.servicePeriodStart)).toBe("2261-11-25");
        expect(iso(l.servicePeriodEnd)).toBe("2262-11-24");
      } else {
        expect(l.servicePeriodStart).toBeNull();
        expect(l.servicePeriodEnd).toBeNull();
      }
    }
  });

  it("showPeriodText aus: kein Kopftext, BG-14/BG-26 trotzdem gesetzt", async () => {
    const rec = await createRecurring(orgId, input({ startDate: D("2261-12-25"), showPeriodText: false }));
    const inv = await load((await emit(rec.id, D("2261-12-25"))).invoiceId);
    expect(inv.headerText ?? "").not.toContain("Leistungszeitraum");
    expect(inv.deliveryDate).toBeNull();
    expect(iso(inv.deliveryStart)).toBe("2261-12-25");
    expect(iso(inv.deliveryEnd)).toBe("2262-12-24");
    expect(iso(inv.lines.find((l) => l.lineType === "ITEM")?.servicePeriodStart)).toBe("2261-12-25");
  });

  it("Belegsprache en: Kopftext in englischem Format", async () => {
    const rec = await createRecurring(orgId, input({ customerId: enCustomerId, startDate: D("2261-10-25") }));
    const inv = await load((await emit(rec.id, D("2261-10-25"))).invoiceId);
    expect(inv.headerText).toBe("Service period 25/10/2261 – 24/10/2262");
  });

  it("ARREARS Bestand (Anker null): BG-14 26.11.2260–25.11.2261", async () => {
    const rec = await createBestandRecurring(orgId, input({ interval: "YEARLY", startDate: D("2261-11-25") }));
    expect(rec.anchorDay).toBeNull();
    const inv = await load((await emit(rec.id, D("2261-11-25"))).invoiceId);
    expect(inv.deliveryDate).toBeNull();
    expect(iso(inv.deliveryStart)).toBe("2260-11-26");
    expect(iso(inv.deliveryEnd)).toBe("2261-11-25");
  });

  it("Verbrauch (ARREARS monatlich): BG-26 der USAGE-Zeile = Laufperiode (01.04.–30.04.), nicht 31.03.", async () => {
    const rec = await createRecurring(orgId, input({ billingTiming: "ARREARS", interval: "MONTHLY", startDate: D("2261-04-01"), lines: [item("Grundgebühr"), usageLine] }));
    expect(iso(rec.nextRunDate)).toBe("2261-04-30");
    const lineId = (await dbInternal.recurringInvoiceLine.findFirstOrThrow({ where: { recurringInvoiceId: rec.id, billing: "USAGE" }, select: { id: true } })).id;
    await recordUsage(orgId, rec.id, { recurringLineId: lineId, quantityMilli: 5000, usageDate: "2261-04-01" }, { source: "API", actor: "t", now: D("2261-04-02") });
    const out = await emit(rec.id, D("2261-05-01"));
    const inv = await load(out.invoiceId);
    const usage = inv.lines.find((l) => l.description === "API-Aufrufe");
    expect(iso(usage?.servicePeriodStart)).toBe("2261-04-01");
    expect(iso(usage?.servicePeriodEnd)).toBe("2261-04-30");
    expect(inv.deliveryDate).toBeNull();
  });

  it("endDate innerhalb der Periode: BG-14 endet am endDate, Abo danach ENDED", async () => {
    const rec = await createRecurring(orgId, input({ startDate: D("2261-01-10"), endDate: D("2261-03-31"), interval: "QUARTERLY" }));
    // erste Periode 10.01.–09.04. wird durch endDate gekürzt
    const out = await emit(rec.id, D("2261-01-10"));
    const inv = await load(out.invoiceId);
    expect(iso(inv.deliveryStart)).toBe("2261-01-10");
    expect(iso(inv.deliveryEnd)).toBe("2261-03-31");
    const after = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id }, select: { status: true } });
    expect(after.status).toBe("ENDED");
  });

  it("maxRuns und Nachholen: drei Läufe, lückenlose Zeiträume", async () => {
    const rec = await createRecurring(orgId, input({ startDate: D("2261-01-05"), interval: "MONTHLY", maxRuns: 3, lines: [item("Dienst")] }));
    const sums = await runDueRecurring({ now: D("2261-03-20"), orgId });
    const ids = sums.flatMap((s) => s.emitted).map((e) => e.invoiceId);
    expect(ids).toHaveLength(3);
    const periods = (await Promise.all(ids.map(load))).map((i) => [iso(i.deliveryStart), iso(i.deliveryEnd)]).sort();
    expect(periods).toEqual([
      ["2261-01-05", "2261-02-04"],
      ["2261-02-05", "2261-03-04"],
      ["2261-03-05", "2261-04-04"],
    ]);
    const after = await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: rec.id }, select: { status: true, issuedCount: true } });
    expect(after).toEqual({ status: "ENDED", issuedCount: 3 });
  });

  it("Fremdwährung USD ADVANCE: Festschreiben gelingt, Kursdatum ≤ Rechnungsdatum", async () => {
    const rec = await createRecurring(orgId, input({ customerId: usdCustomerId, startDate: D("2261-11-20"), autoFinalize: true }));
    const out = await emit(rec.id, D("2261-11-20"));
    expect(out.finalized).toBe(true);
    const inv = await load(out.invoiceId);
    expect(inv.fxRateDate).not.toBeNull();
    expect(inv.fxRateDate!.getTime()).toBeLessThanOrEqual(inv.issueDate.getTime());
  });
});

describe("Sammelrechnung", () => {
  const coll = (extra: Record<string, unknown>) => input({ collectiveBilling: true, invoiceHeading: "Block", lines: [item("Leistung")], ...extra });

  it("zwei ADVANCE-Abos: eine Rechnung, BG-26 je Block, BG-14 = Min/Max, kein BT-72", async () => {
    const cust = (await dbInternal.customer.create({ data: { orgId, name: "Sammel ADV", addressLine1: "Weg 1", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "s1@example.org" } })).id;
    const a = await createRecurring(orgId, coll({ customerId: cust, startDate: D("2261-06-15"), interval: "MONTHLY", title: "SA", invoiceHeading: "A" }));
    const b = await createRecurring(orgId, coll({ customerId: cust, startDate: D("2261-06-15"), interval: "YEARLY", title: "SB", invoiceHeading: "B" }));
    const sums = await runDueRecurring({ now: D("2261-06-15"), orgId });
    const emitted = sums.flatMap((s) => s.emitted).filter((e) => e.collectiveRecurringIds?.includes(a.id));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].collectiveRecurringIds).toEqual([a.id, b.id].sort());
    const inv = await load(emitted[0].invoiceId);
    expect(inv.deliveryDate).toBeNull();
    expect(iso(inv.deliveryStart)).toBe("2261-06-15");
    expect(iso(inv.deliveryEnd)).toBe("2262-06-14");
    const items = inv.lines.filter((l) => l.lineType === "ITEM");
    expect(items.map((l) => iso(l.servicePeriodEnd)).sort()).toEqual(["2261-07-14", "2262-06-14"]);
  });

  it("ADVANCE + ARREARS am selben Stichtag: zwei Rechnungen, Grund Abrechnungsart", async () => {
    const cust = (await dbInternal.customer.create({ data: { orgId, name: "Sammel Mix", addressLine1: "Weg 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", email: "s2@example.org" } })).id;
    const a = await createRecurring(orgId, coll({ customerId: cust, startDate: D("2261-08-10"), interval: "MONTHLY", title: "MA", invoiceHeading: "A" }));
    const b = await createRecurring(orgId, coll({ customerId: cust, startDate: D("2261-07-11"), interval: "MONTHLY", billingTiming: "ARREARS", title: "MB", invoiceHeading: "B" }));
    expect(iso(a.nextRunDate)).toBe(iso(b.nextRunDate));
    const sums = await runDueRecurring({ now: D("2261-08-10"), orgId });
    const mine = sums.filter((s) => [a.id, b.id].includes(s.recurringId)).flatMap((s) => s.emitted);
    expect(mine).toHaveLength(2);
    expect(mine.every((e) => !e.collectiveRecurringIds)).toBe(true);
    const splitLog = await dbInternal.activityLog.findFirstOrThrow({ where: { orgId, entityId: b.id, type: "COLLECTIVE_SPLIT" }, select: { dataJson: true } }).catch(() =>
      dbInternal.activityLog.findFirstOrThrow({ where: { orgId, entityId: a.id, type: "COLLECTIVE_SPLIT" }, select: { dataJson: true } }),
    );
    expect(JSON.parse(splitLog.dataJson ?? "{}").reasons).toEqual(["billingTiming"]);
  });
});
