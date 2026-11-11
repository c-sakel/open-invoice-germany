/** Phase 16f, Task 5 — topProducts. Eigenes Jahr 2106. */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { topProducts } from "@/domain/reporting/top-products";
import { createInvoiceSchema } from "@/schemas";

const NOW = new Date(Date.UTC(2106, 5, 15, 10));
const MARCH = new Date(Date.UTC(2106, 2, 10, 10));
const APRIL = new Date(Date.UTC(2106, 3, 10, 10));

type Org = { orgId: string; customerId: string };
let orgSeq = 0;
async function mkOrg(name: string, vat: string): Promise<Org> {
  const o = await dbInternal.organization.create({ data: { legalName: name, addressLine1: "P 1", postalCode: "10115", city: "Berlin", vatId: vat, taxNumber: "83/333/33333" } });
  await ensureOrgMasterdata(dbInternal, o.id);
  // Invoice.number ist global eindeutig -> je Org eigener Praefix (Muster number-ranges).
  orgSeq += 1;
  // Je Org eigener Praefix fuer Rechnungs- und Gutschriftskreis (jahresabhaengig und -unabhaengig).
  for (const docType of ["INVOICE", "CREDIT_NOTE"]) {
    for (const year of [0, 2106]) {
      await dbInternal.numberRange.upsert({
        where: { orgId_docType_year: { orgId: o.id, docType, year } },
        create: { orgId: o.id, docType, year, prefix: `TP${docType === "INVOICE" ? "R" : "G"}${orgSeq}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
        update: { prefix: `TP${docType === "INVOICE" ? "R" : "G"}${orgSeq}-` },
      });
    }
  }
  const c = await dbInternal.customer.create({ data: { orgId: o.id, name: "Kunde", addressLine1: "A 1", postalCode: "10117", city: "Berlin", type: "BUSINESS" } });
  return { orgId: o.id, customerId: c.id };
}
function ln(productId: string | undefined, netCents: number, description = "Posten", quantityMilli = 1000) {
  return { productId, description, quantityMilli, unit: "C62", unitNetPriceCents: netCents, taxRate: 19 as const, taxCategory: "S" as const, discountPermille: 0 };
}
async function invoice(o: Org, lines: ReturnType<typeof ln>[], issueDate: Date, opts: { currency?: string; finalize?: boolean } = {}) {
  const inv = await createDraftInvoice(
    o.orgId,
    createInvoiceSchema.parse({ customerId: o.customerId, type: "INVOICE", taxScheme: "REGULAR", currency: opts.currency ?? "EUR", issueDate, lines, ...(opts.currency && opts.currency !== "EUR" ? { fxOverrideRate: "1,1" } : {}) }),
    { now: issueDate },
  );
  if (opts.finalize !== false) await finalizeInvoice(inv.id, { now: issueDate });
  return inv;
}

describe("topProducts", () => {
  it("Summe je Produkt, DRAFT ausgeschlossen", async () => {
    const o = await mkOrg("TopP A GmbH", "DE833333331");
    await invoice(o, [ln("pA", 10000, "Alt"), ln("pB", 500)], MARCH);
    await invoice(o, [ln("pA", 5000, "Neu", 2000)], APRIL);
    await invoice(o, [ln("pA", 99999)], APRIL, { finalize: false });
    const rows = await topProducts(o.orgId, { months: 6, now: NOW });
    const a = rows.find((r) => r.productId === "pA");
    expect(a).toMatchObject({ netCents: 20000, quantityMilli: 3000, name: "Neu", currency: "EUR" });
  });

  it("Storno/Gutschrift negativ", async () => {
    const o = await mkOrg("TopP B GmbH", "DE833333332");
    const inv = await invoice(o, [ln("pS", 10000)], MARCH);
    await cancelInvoice(inv.id, { orgId: o.orgId, now: APRIL });
    const rows = await topProducts(o.orgId, { months: 6, now: NOW });
    expect(rows.find((r) => r.productId === "pS")).toMatchObject({ netCents: 0, quantityMilli: 0 });
  });

  it("payableCents anteilig, kein Doppelzählen", async () => {
    const o = await mkOrg("TopP C GmbH", "DE833333333");
    const inv = await invoice(o, [ln("pP", 10000)], MARCH); // brutto 11900
    await dbInternal.invoice.update({ where: { id: inv.id }, data: { payableCents: 5950 } });
    const rows = await topProducts(o.orgId, { months: 6, now: NOW });
    expect(rows.find((r) => r.productId === "pP")?.netCents).toBe(5000);
  });

  it("Zeilen ohne productId fehlen", async () => {
    const o = await mkOrg("TopP D GmbH", "DE833333334");
    await invoice(o, [ln(undefined, 10000)], MARCH);
    expect(await topProducts(o.orgId, { months: 6, now: NOW })).toEqual([]);
  });

  it("limit und Sortierung", async () => {
    const o = await mkOrg("TopP E GmbH", "DE833333335");
    await invoice(o, [ln("p1", 100), ln("p2", 300), ln("p3", 200)], MARCH);
    const rows = await topProducts(o.orgId, { months: 6, limit: 2, now: NOW });
    expect(rows.map((r) => r.productId)).toEqual(["p2", "p3"]);
  });

  it("Währungstrennung", async () => {
    const o = await mkOrg("TopP F GmbH", "DE833333336");
    await invoice(o, [ln("pX", 100)], MARCH);
    await invoice(o, [ln("pX", 700)], MARCH, { currency: "USD" });
    const rows = await topProducts(o.orgId, { months: 6, now: NOW });
    expect(rows.map((r) => [r.currency, r.netCents])).toEqual([["EUR", 100], ["USD", 700]]);
  });

  it("fremde Org unsichtbar", async () => {
    const o = await mkOrg("TopP G GmbH", "DE833333337");
    const other = await mkOrg("TopP H GmbH", "DE833333338");
    await invoice(o, [ln("pO", 100)], MARCH);
    expect(await topProducts(other.orgId, { months: 6, now: NOW })).toEqual([]);
  });
});
