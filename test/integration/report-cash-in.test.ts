/** Phase 16f, Task 5 — monthlyCashIn. Eigenes Jahr 2104 (Invoice.number global eindeutig). */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { monthlyCashIn } from "@/domain/reporting/cash-in";
import type { CreateInvoiceInput } from "@/schemas";

const NOW = new Date(Date.UTC(2104, 5, 15, 10));
const MARCH = new Date(Date.UTC(2104, 2, 10, 10));
const APRIL = new Date(Date.UTC(2104, 3, 10, 10));
const MAY = new Date(Date.UTC(2104, 4, 10, 10));

let orgId: string;
let otherOrgId: string;
let customerId: string;

function line(netCents: number) {
  return { description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
}
async function invoice(org: string, cust: string, netCents: number, issueDate: Date, opts: { currency?: string; finalize?: boolean } = {}) {
  const inv = await createDraftInvoice(
    org,
    { customerId: cust, type: "INVOICE", taxScheme: "REGULAR", currency: opts.currency ?? "EUR", issueDate, lines: [line(netCents)], ...(opts.currency && opts.currency !== "EUR" ? { fxOverrideRate: 1100000 } : {}) } as CreateInvoiceInput,
    { now: issueDate },
  );
  if (opts.finalize !== false) await finalizeInvoice(inv.id, { now: issueDate });
  return inv;
}
const pay = (invoiceId: string, amountCents: number, paidAt: Date) =>
  recordPayment(invoiceId, { amountCents, paidAt, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, now: paidAt });
const row = (rows: Awaited<ReturnType<typeof monthlyCashIn>>, month: string, currency = "EUR") => rows.find((r) => r.month === month && r.currency === currency);

let orgSeq = 0;
async function mkOrg(name: string, vat: string) {
  const o = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "K 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "81/111/11111" } });
  await ensureOrgMasterdata(dbInternal, o.id);
  // Invoice.number ist global eindeutig -> je Org eigener Praefix (Muster number-ranges).
  orgSeq += 1;
  // Je Org eigener Praefix fuer Rechnungs- und Gutschriftskreis (jahresabhaengig und -unabhaengig).
  for (const docType of ["INVOICE", "CREDIT_NOTE"]) {
    for (const year of [0, 2104]) {
      await dbInternal.numberRange.upsert({
        where: { orgId_docType_year: { orgId: o.id, docType, year } },
        create: { orgId: o.id, docType, year, prefix: `CI${docType === "INVOICE" ? "R" : "G"}${orgSeq}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
        update: { prefix: `CI${docType === "INVOICE" ? "R" : "G"}${orgSeq}-` },
      });
    }
  }
  const c = await dbInternal.customer.create({ data: { orgId: o.id, name: "Kunde", addressLine1: "A 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } });
  return { orgId: o.id, customerId: c.id };
}

beforeAll(async () => {
  ({ orgId, customerId } = await mkOrg("CashIn GmbH", "DE811111111"));
  otherOrgId = (await mkOrg("CashIn Fremd GmbH", "DE811111112")).orgId;
});

describe("monthlyCashIn", () => {
  it("Zahlung zählt im Monat von paidAt", async () => {
    const inv = await invoice(orgId, customerId, 10000, MARCH);
    await pay(inv.id, 5000, APRIL);
    const rows = await monthlyCashIn(orgId, { months: 6, now: NOW });
    expect(row(rows, "2104-04")?.paidCents).toBe(5000);
    expect(row(rows, "2104-03")?.paidCents).toBe(0);
  });

  it("Gegenbuchung mindert den Monat der Gegenbuchung", async () => {
    const o = await mkOrg("CashIn Reversal GmbH", "DE811111113");
    const inv = await invoice(o.orgId, o.customerId, 10000, MARCH);
    const p = await recordPayment(inv.id, { amountCents: 10000, paidAt: MARCH, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: o.orgId, now: MARCH });
    await reversePayment(p.recorded.id, { amountCents: 4000, reason: "Rücklastschrift" }, { actor: "t", orgId: o.orgId, now: APRIL });
    const rows = await monthlyCashIn(o.orgId, { months: 6, now: NOW });
    expect(row(rows, "2104-03")?.paidCents).toBe(10000);
    expect(row(rows, "2104-04")?.paidCents).toBe(-4000);
  });

  it("CREDIT_NOTE-Verrechnung und Skonto zählen nicht", async () => {
    const o = await mkOrg("CashIn Skonto GmbH", "DE811111114");
    const inv = await invoice(o.orgId, o.customerId, 10000, MARCH);
    await dbInternal.payment.createMany({
      data: [
        { invoiceId: inv.id, amountCents: 3000, paidAt: MARCH, method: "CREDIT_NOTE" },
        { invoiceId: inv.id, amountCents: 200, paidAt: MARCH, method: "SKONTO", isSkonto: true },
        { invoiceId: inv.id, amountCents: 100, paidAt: MARCH, method: "TRANSFER", isSkonto: true },
        { invoiceId: inv.id, amountCents: -3000, paidAt: APRIL, method: "CREDIT_NOTE", kind: "REVERSAL" },
        { invoiceId: inv.id, amountCents: 700, paidAt: MARCH, method: "TRANSFER" },
      ],
    });
    const rows = await monthlyCashIn(o.orgId, { months: 6, now: NOW });
    expect(row(rows, "2104-03")?.paidCents).toBe(700);
    expect(row(rows, "2104-04")?.paidCents).toBe(0);
  });

  it("fremde Org unsichtbar", async () => {
    const rows = await monthlyCashIn(otherOrgId, { months: 6, now: NOW });
    expect(rows).toEqual([]);
  });

  it("Monat ohne Beleg = 0-Bucket", async () => {
    const rows = await monthlyCashIn(orgId, { months: 6, now: NOW });
    expect(rows.filter((r) => r.currency === "EUR")).toHaveLength(6);
    expect(row(rows, "2104-01")).toEqual({ month: "2104-01", currency: "EUR", paidCents: 0, invoicedGrossCents: 0 });
  });

  it("USD getrennt von EUR", async () => {
    const o = await mkOrg("CashIn USD GmbH", "DE811111115");
    const eur = await invoice(o.orgId, o.customerId, 10000, MAY);
    const usd = await invoice(o.orgId, o.customerId, 20000, MAY, { currency: "USD" });
    await recordPayment(eur.id, { amountCents: 1000, paidAt: MAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: o.orgId, now: MAY });
    await recordPayment(usd.id, { amountCents: 2000, paidAt: MAY, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: o.orgId, now: MAY });
    const rows = await monthlyCashIn(o.orgId, { months: 3, now: NOW });
    expect(row(rows, "2104-05", "EUR")?.paidCents).toBe(1000);
    expect(row(rows, "2104-05", "USD")?.paidCents).toBe(2000);
    expect(new Set(rows.map((r) => r.currency))).toEqual(new Set(["EUR", "USD"]));
  });

  it("invoicedGrossCents: DRAFT raus, Gutschrift negativ", async () => {
    const o = await mkOrg("CashIn Brutto GmbH", "DE811111116");
    const inv = await invoice(o.orgId, o.customerId, 10000, MARCH); // brutto 11900
    await invoice(o.orgId, o.customerId, 99999, MARCH, { finalize: false });
    await createPartialCreditNote(inv.id, { lines: [{ description: "Teil", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S" }] }, { orgId: o.orgId, now: APRIL });
    const rows = await monthlyCashIn(o.orgId, { months: 6, now: NOW });
    expect(row(rows, "2104-03")?.invoicedGrossCents).toBe(11900);
    expect(row(rows, "2104-04")?.invoicedGrossCents).toBe(-1190);
  });

  it("Fensterrand: Monat vor dem Start ist ausgeschlossen", async () => {
    const o = await mkOrg("CashIn Fenster GmbH", "DE811111117");
    const inv = await invoice(o.orgId, o.customerId, 10000, MARCH);
    await recordPayment(inv.id, { amountCents: 1000, paidAt: new Date(Date.UTC(2104, 0, 31, 23, 59)), method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: o.orgId, now: MARCH });
    await recordPayment(inv.id, { amountCents: 2000, paidAt: new Date(Date.UTC(2104, 1, 1)), method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: o.orgId, now: MARCH });
    const rows = await monthlyCashIn(o.orgId, { months: 5, now: NOW }); // Februar bis Juni
    expect(rows.filter((r) => r.currency === "EUR").map((r) => r.month)).toEqual(["2104-02", "2104-03", "2104-04", "2104-05", "2104-06"]);
    expect(rows.reduce((sum, r) => sum + r.paidCents, 0)).toBe(2000);
  });
});
