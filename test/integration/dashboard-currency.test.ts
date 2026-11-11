/** Phase 16f Final-Fix: Dashboard summiert nur die Standardwaehrung (keine Mischsummen). Eigenes Jahr 2112. */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { dashboardSummary } from "@/domain/dashboard/summary";
import { monthlyRevenue } from "@/domain/reporting/revenue";
import { topCustomers } from "@/domain/reporting/customers";
import { createInvoiceSchema } from "@/schemas";

const NOW = new Date(2112, 4, 15, 10, 0, 0);
const line = (cents: number) => ({
  description: "Leistung",
  quantityMilli: 1000,
  unit: "HUR" as const,
  unitNetPriceCents: cents,
  taxRate: 19 as const,
  taxCategory: "S" as const,
  discountPermille: 0,
});

describe("Dashboard nur Standardwaehrung", () => {
  it("summiert EUR getrennt von USD und meldet weitere Waehrungen", async () => {
    const org = await dbInternal.organization.create({
      data: { legalName: "Waehrung Test GmbH", addressLine1: "W 1", postalCode: "10115", city: "Berlin", vatId: "DE844444444", taxNumber: "84/444/44444" },
    });
    await ensureOrgMasterdata(dbInternal, org.id);
    const customer = await dbInternal.customer.create({
      data: { orgId: org.id, name: "Waehrungskunde", addressLine1: "K 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" },
    });
    for (const [currency, cents] of [["EUR", 10000], ["USD", 50000]] as const) {
      const inv = await createDraftInvoice(
        org.id,
        createInvoiceSchema.parse({ customerId: customer.id, type: "INVOICE", taxScheme: "REGULAR", currency, issueDate: NOW, lines: [line(cents)], ...(currency === "EUR" ? {} : { fxOverrideRate: "1,1" }) }),
        { now: NOW },
      );
      await finalizeInvoice(inv.id, { now: NOW });
    }

    const mixed = await dashboardSummary(org.id, NOW);
    expect(mixed.otherCurrencyCount).toBe(0);
    expect(mixed.revenueThisMonthCents).toBe(60000);

    const eur = await dashboardSummary(org.id, NOW, { currency: "EUR" });
    expect(eur.revenueThisMonthCents).toBe(10000);
    expect(eur.openInvoices.cents + eur.dueInvoices.cents + eur.overdueInvoices.cents).toBe(11900);
    expect(eur.otherCurrencyCount).toBe(1);

    const rev = await monthlyRevenue(org.id, { months: 1, now: NOW, currency: "USD" });
    expect(rev[0].netCents).toBe(50000);
    const top = await topCustomers(org.id, { now: NOW, currency: "EUR" });
    expect(top[0].netCents).toBe(10000);
  });
});
