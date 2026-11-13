/**
 * Phase 17c Fix-Welle 2 — Auswertung `revenue` je Waehrung (Zeilen je Waehrung, optionaler
 * `currency`-Filter, CSV mit Waehrungsspalte). Testjahr 2157, Nummernkreis-Praefix C17W2-.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { updateNumberRange } from "@/domain/numbering/ranges";
import { runReport, reportQuerySchema } from "@/domain/reporting/query";
import { reportToCsv } from "@/domain/reporting/csv";
import { createInvoiceSchema } from "@/schemas";

let orgId: string;
let customerId: string;

const ISSUE = new Date("2157-04-10T10:00:00.000Z");
const NOW = new Date("2157-04-15T10:00:00.000Z");

async function invoice(currency: string, netCents: number) {
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency,
      issueDate: ISSUE,
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: ISSUE },
  );
  return finalizeInvoice(d.id, { now: ISSUE });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Waehrung Umsatz GmbH", addressLine1: "Waehrungsweg 1", postalCode: "10115", city: "Berlin", vatId: "DE215700001", taxNumber: "21/570/00001" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await updateNumberRange(orgId, "INVOICE", { pattern: "{PREFIX}{YYYY}-{SEQ}", prefix: "C17W2-", seqPadding: 4, yearlyReset: true, nextValue: 1 }, "test", new Date("2157-01-01T10:00:00Z"));
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Waehrung AG", addressLine1: "W 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } })).id;
  await dbInternal.exchangeRate.upsert({
    where: { source_currency_rateDate: { source: "MONTHLY", currency: "USD", rateDate: new Date("2157-04-01T00:00:00.000Z") } },
    create: { source: "MONTHLY", currency: "USD", rateDate: new Date("2157-04-01T00:00:00.000Z"), rateMicros: 1_100_000 },
    update: {},
  });
  await invoice("EUR", 10000);
  await invoice("USD", 30000);
});

describe("revenue je Waehrung", () => {
  it("Schema: currency nur bei revenue, nur ISO-Grossbuchstaben", () => {
    expect(reportQuerySchema.safeParse({ type: "revenue", currency: "USD" }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ type: "revenue", currency: "usd" }).success).toBe(false);
    const other = reportQuerySchema.safeParse({ type: "top-customers", currency: "EUR" });
    expect(other.success).toBe(false);
    expect(other.success === false && other.error.issues[0].message).toContain("currency");
  });

  it("ohne Filter je Waehrung eine eigene Reihe, nie addiert", async () => {
    const r = await runReport(orgId, { type: "revenue", months: 2 }, NOW);
    expect(r.rows).toHaveLength(4);
    const apr = (r.rows as { month: string; currency: string; netCents: number }[]).filter((x) => x.month === "2157-04");
    expect(apr.map((x) => [x.currency, x.netCents])).toEqual([["EUR", 10000], ["USD", 30000]]);
    const csv = reportToCsv(r);
    expect(csv).toContain("Monat;Währung;Netto;Anzahl");
    expect(csv).toContain("2157-04;USD;300,00;1");
  });

  it("mit currency nur diese Waehrung, luecklos", async () => {
    const r = await runReport(orgId, { type: "revenue", months: 2, currency: "USD" }, NOW);
    expect(r.rows).toHaveLength(2);
    expect((r.rows as { currency: string }[]).every((x) => x.currency === "USD")).toBe(true);
    const empty = await runReport(orgId, { type: "revenue", months: 2, currency: "CHF" }, NOW);
    expect(empty.rows).toHaveLength(2);
  });
});
