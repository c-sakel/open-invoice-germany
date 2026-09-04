/**
 * Phase 8b, Task 4 — Domain-Tests: `dashboardSummary` (src/domain/dashboard/summary.ts),
 * `agingBuckets` (geteilter Aging-Helfer, auch von `loadDunningOverview` genutzt) und
 * `customerOverview` (src/domain/customer/overview.ts). Eigenes Jahr 2066
 * (Testjahr-Konvention, plan-header.md).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createBusinessDocument } from "@/domain/document/create";
import { setQuoteStatus } from "@/domain/document/status";
import { dashboardSummary, agingBuckets } from "@/domain/dashboard/summary";
import { customerOverview } from "@/domain/customer/overview";
import { NotFoundError } from "@/domain/errors";
import type { CreateInvoiceInput, CreateDocumentInput } from "@/schemas";

let orgId: string;
let customerId: string;

const NOW = new Date(2066, 4, 15, 10, 0, 0);
const PAST_10 = new Date(2066, 4, 5, 10, 0, 0);
const PAST_40 = new Date(2066, 3, 5, 10, 0, 0);

function line(description: string) {
  return {
    description,
    quantityMilli: 1000,
    unit: "HUR" as const,
    unitNetPriceCents: 10000,
    taxRate: 19 as const,
    taxCategory: "S" as const,
    discountPermille: 0,
  };
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Dashboard Test GmbH", addressLine1: "Dashboardweg 1", postalCode: "10115", city: "Berlin", vatId: "DE111222333", taxNumber: "44/555/66677" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);

  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Dashboardkunde AG", addressLine1: "Marktplatz 3", postalCode: "10117", city: "Berlin", type: "BUSINESS" },
  });
  customerId = customer.id;

  // Rechnung 1: ueberfaellig seit 10 Tagen (Bucket d1_7 faellt raus, d8_30 trifft).
  const inv1 = await createDraftInvoice(
    orgId,
    { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: PAST_40, lines: [line("Dashboard ueberfaellig 10 Tage")] } as CreateInvoiceInput,
    { now: PAST_40 },
  );
  await dbInternal.invoice.update({ where: { id: inv1.id }, data: { dueDate: PAST_10 } });
  await finalizeInvoice(inv1.id, { now: PAST_40 });

  // Rechnung 2: ueberfaellig seit 40 Tagen (Bucket d31_60).
  const inv2 = await createDraftInvoice(
    orgId,
    { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: PAST_40, lines: [line("Dashboard ueberfaellig 40 Tage")] } as CreateInvoiceInput,
    { now: PAST_40 },
  );
  await dbInternal.invoice.update({ where: { id: inv2.id }, data: { dueDate: PAST_40 } });
  await finalizeInvoice(inv2.id, { now: PAST_40 });

  // Rechnung 3: im laufenden Monat ausgestellt (Umsatz laufender Monat), bereits bezahlt.
  const inv3 = await createDraftInvoice(
    orgId,
    { customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", issueDate: NOW, dueDate: NOW, lines: [line("Dashboard Umsatz laufender Monat")] } as CreateInvoiceInput,
    { now: NOW },
  );
  await finalizeInvoice(inv3.id, { now: NOW });

  // NOW liegt im Jahr 2066 — createBusinessDocument setzt ohne explizites `validUntil`
  // den Default relativ zur ECHTEN Systemzeit (kein injizierbares `now`, siehe
  // src/domain/document/create.ts), das laege also VOR dem fiktiven Testjahr und wuerde
  // effectiveQuoteStatus sofort auf EXPIRED setzen. Deshalb hier explizit in der Zukunft
  // relativ zu NOW.
  const FAR_FUTURE = new Date(2066, 11, 31);

  // Angebot: offen (DRAFT).
  await createBusinessDocument(orgId, {
    kind: "ANGEBOT",
    customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    validUntil: FAR_FUTURE,
    lines: [line("Dashboard offenes Angebot")],
  } as CreateDocumentInput);

  // Angebot: bereits angenommen (zaehlt NICHT als offen).
  const acceptedQuote = await createBusinessDocument(orgId, {
    kind: "ANGEBOT",
    customerId,
    taxScheme: "REGULAR",
    currency: "EUR",
    validUntil: FAR_FUTURE,
    lines: [line("Dashboard angenommenes Angebot")],
  } as CreateDocumentInput);
  await setQuoteStatus(orgId, acceptedQuote.id, "SENT", { now: NOW });
  await setQuoteStatus(orgId, acceptedQuote.id, "ACCEPTED", { now: NOW });
});

describe("agingBuckets", () => {
  it("ordnet Zeilen den richtigen Buckets zu und laesst daysOverdue < 1 aussen vor", () => {
    const result = agingBuckets(
      [
        { dueDate: PAST_10, cents: 1000 }, // 10 Tage -> d8_30
        { dueDate: PAST_40, cents: 2000 }, // 40 Tage -> d31_60
        { dueDate: NOW, cents: 500 }, // heute faellig -> zaehlt NICHT
      ],
      NOW,
    );
    expect(result.d1_7).toEqual({ count: 0, cents: 0 });
    expect(result.d8_30).toEqual({ count: 1, cents: 1000 });
    expect(result.d31_60).toEqual({ count: 1, cents: 2000 });
    expect(result.d60plus).toEqual({ count: 0, cents: 0 });
  });

  it("respektiert benutzerdefinierte bounds", () => {
    const result = agingBuckets([{ dueDate: PAST_10, cents: 1000 }], NOW, [3, 20, 50]);
    expect(result.d1_7.count).toBe(0); // 10 Tage > bounds[0]=3
    expect(result.d8_30.count).toBe(1); // <= bounds[1]=20
  });
});

describe("dashboardSummary", () => {
  it("liefert ueberfaellige Rechnungen, Aging, Umsatz laufender Monat und offene Angebote", async () => {
    const summary = await dashboardSummary(orgId, NOW);

    expect(summary.overdueInvoices.count).toBe(2);
    expect(summary.overdueInvoices.cents).toBeGreaterThan(0);

    const bucketTotal = summary.aging.d1_7.count + summary.aging.d8_30.count + summary.aging.d31_60.count + summary.aging.d60plus.count;
    expect(bucketTotal).toBe(2);
    expect(summary.aging.d8_30.count).toBe(1);
    expect(summary.aging.d31_60.count).toBe(1);

    expect(summary.revenueThisMonthCents).toBeGreaterThan(0);

    expect(summary.recentDocuments.length).toBeGreaterThan(0);
    expect(summary.recentDocuments.length).toBeLessThanOrEqual(5);

    // Ein Angebot ist offen (DRAFT), eines wurde bereits angenommen.
    expect(summary.openQuotes.count).toBe(1);
  });
});

describe("customerOverview", () => {
  it("liefert KPIs und Belegtabs des Kunden", async () => {
    const overview = await customerOverview(orgId, customerId, NOW);
    expect(overview.customer.id).toBe(customerId);
    expect(overview.kpis.overdueCents).toBeGreaterThan(0);
    expect(overview.kpis.totalRevenueCents).toBeGreaterThan(0);
    expect(overview.invoices.length).toBe(3);
    expect(overview.quotes.length).toBe(2);
  });

  it("wirft NotFoundError fuer unbekannten Kunden", async () => {
    await expect(customerOverview(orgId, "does-not-exist", NOW)).rejects.toThrow(NotFoundError);
  });

  it("wirft NotFoundError fuer Kunden einer anderen Organisation (Org-Scoping)", async () => {
    const otherOrg = await dbInternal.organization.create({
      data: { legalName: "Fremdorg GmbH", addressLine1: "Fremdweg 1", postalCode: "10119", city: "Berlin", vatId: "DE999888777", taxNumber: "77/888/99900" },
    });
    await expect(customerOverview(otherOrg.id, customerId, NOW)).rejects.toThrow(NotFoundError);
  });
});
