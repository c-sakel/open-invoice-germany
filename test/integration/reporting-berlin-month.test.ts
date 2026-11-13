/**
 * Phase 17c, Task 1 — Auswertungen nach Berliner Kalendermonat, OSS-Jahr nach Berliner Jahr.
 * Testjahre 2150 (+2151 nur fuer die Jahresgrenze); Nummernkreis-Praefix C17T1-.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { monthlyRevenue } from "@/domain/reporting/revenue";
import { monthlyCashIn } from "@/domain/reporting/cash-in";
import { topCustomers } from "@/domain/reporting/customers";
import { topProducts } from "@/domain/reporting/top-products";
import { quoteOutcome } from "@/domain/reporting/quote-outcome";
import { dashboardSummary } from "@/domain/dashboard/summary";
import { ossThreshold } from "@/domain/reporting/oss";
import { checkOssNotifications } from "@/domain/reporting/oss-notify";
import { saveNotificationSettings } from "@/domain/notifications/settings";
import { createInvoiceSchema } from "@/schemas";

let orgId: string;
let customerId: string;
let atId: string;

const NIGHT = new Date("2150-03-31T22:30:00.000Z"); // 01.04. 00:30 Berlin
const EVENING = new Date("2150-03-31T21:30:00.000Z"); // 31.03. 23:30 Berlin
const DATE_ONLY = new Date("2150-04-01T00:00:00.000Z");
const NOW = new Date("2150-04-15T10:00:00.000Z");

function line(netCents: number) {
  return { productId: "p17t1", description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 };
}

async function invoice(cust: string, netCents: number, issueDate: Date, deliveryDate?: Date) {
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({ customerId: cust, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate, ...(deliveryDate ? { deliveryDate } : {}), lines: [line(netCents)] }),
    { now: issueDate },
  );
  return finalizeInvoice(d.id, { now: issueDate });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Berlin Monat GmbH", addressLine1: "Monatsweg 1", postalCode: "10115", city: "Berlin", vatId: "DE215000001", taxNumber: "21/150/00001" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await updateNumberRange(orgId, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "C17T1-", seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", new Date("2150-01-01T10:00:00Z"));
  await updateNumberRange(orgId, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "C17T1-", seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", new Date("2151-01-01T10:00:00Z"));
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Monat AG", addressLine1: "M 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } })).id;
  atId = (await dbInternal.customer.create({ data: { orgId, name: "AT privat", addressLine1: "Weg 1", postalCode: "1010", city: "Ort", countryCode: "AT", vatId: null, type: "PRIVATE" } })).id;
  await saveNotificationSettings(orgId, { enabledTypes: [], emailDigest: false });
});

describe("Berliner Kalendermonat in den Auswertungen", () => {
  let nightInv: string;
  let eveningInv: string;

  beforeAll(async () => {
    nightInv = (await invoice(customerId, 10000, NIGHT)).id;
    eveningInv = (await invoice(customerId, 20000, EVENING)).id;
    await invoice(customerId, 40000, DATE_ONLY);
  });

  it("monthlyRevenue: 22:30Z in April, 21:30Z in Maerz, date-only im April", async () => {
    const rows = await monthlyRevenue(orgId, { months: 2, now: NOW });
    expect(rows.find((r) => r.month === "2150-03")?.netCents).toBe(20000);
    expect(rows.find((r) => r.month === "2150-04")?.netCents).toBe(50000);
  });

  it("monthlyCashIn: Zahlung 22:30Z zaehlt im April", async () => {
    await recordPayment(nightInv, { amountCents: 11900, paidAt: NIGHT, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: NIGHT });
    await recordPayment(eveningInv, { amountCents: 5000, paidAt: EVENING, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: EVENING });
    const rows = await monthlyCashIn(orgId, { months: 2, now: NOW });
    const sum = (m: string) => rows.filter((r) => r.month === m).reduce((s, r) => s + r.paidCents, 0);
    expect(sum("2150-04")).toBe(11900);
    expect(sum("2150-03")).toBe(5000);
  });

  it("topCustomers / topProducts / quoteOutcome mit months 1", async () => {
    const c = await topCustomers(orgId, { months: 1, now: NOW });
    expect(c.reduce((s, r) => s + r.netCents, 0)).toBe(50000);
    const p = await topProducts(orgId, { months: 1, now: NOW });
    expect(p.reduce((s, r) => s + r.netCents, 0)).toBe(50000);
    const quote = (issueDate: Date) =>
      dbInternal.quote.create({ data: { orgId, customerId, status: "ACCEPTED", netTotalCents: 700, kind: "ANGEBOT", issueDate, currency: "EUR" } });
    await quote(NIGHT);
    await quote(EVENING);
    const [q] = await quoteOutcome(orgId, { months: 1, now: NOW });
    expect(q?.accepted).toEqual({ count: 1, netCents: 700 });
  });

  it("dashboardSummary 00:30 Berlin am 1. April: nur der Nachtbeleg und der date-only-Beleg", async () => {
    const s = await dashboardSummary(orgId, new Date("2150-03-31T22:30:00.000Z"), { currency: "EUR" });
    expect(s.revenueThisMonthCents).toBe(50000);
  });
});

describe("OSS-Jahr nach Berliner Jahr", () => {
  it("ohne Leistungsdatum zaehlt Silvester 23:30Z im Folgejahr, mit Leistungsdatum im Leistungsjahr", async () => {
    await invoice(atId, 100000, new Date("2150-12-31T23:30:00.000Z"));
    await invoice(atId, 200000, new Date("2150-12-31T23:30:00.000Z"), new Date("2150-12-31T00:00:00.000Z"));
    expect((await ossThreshold(orgId, 2151)).current.netEurCents).toBe(100000);
    expect((await ossThreshold(orgId, 2150)).current.netEurCents).toBe(200000);
  });

  it("checkOssNotifications nutzt das Berliner Jahr im dedupeKey", async () => {
    await invoice(atId, 1_100_000, new Date("2150-12-31T23:30:00.000Z"));
    await checkOssNotifications(orgId, new Date("2150-12-31T23:30:00.000Z"));
    // Benachrichtigungstyp ist abgewaehlt: Schluessel prueft die Domainfunktion selbst, daher Typ kurz aktivieren.
    await saveNotificationSettings(orgId, { enabledTypes: ["OSS_THRESHOLD"], emailDigest: false });
    await checkOssNotifications(orgId, new Date("2150-12-31T23:30:00.000Z"));
    const notes = await dbInternal.notification.findMany({ where: { orgId, type: "OSS_THRESHOLD" }, select: { dedupeKey: true } });
    expect(notes.map((n) => n.dedupeKey)).toContain("oss-2151-100");
  });
});
