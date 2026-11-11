/**
 * Phase 16b, Task 6: loadEInvoiceData liefert den EUR-Block fuer Fremdwaehrungsbelege —
 * Entwurf live per rateFor (preview), festgeschriebener Beleg aus dem eingefrorenen Snapshot,
 * EUR-Beleg ohne Block. Eigenes Testjahr (2110): Invoice.number und ExchangeRate sind instanzweit eindeutig.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { upsertManualRate } from "@/domain/fx/store";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { createInvoiceSchema } from "@/schemas";
import { exchangeRateUpsertSchema } from "@/schemas/fx";

const NOW = new Date("2110-03-20T10:00:00.000Z");
const DELIVERY = new Date("2110-03-12T00:00:00.000Z");

let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Lade GmbH", addressLine1: "Kursweg 1", postalCode: "10115", city: "Berlin", vatId: "DE211021101", taxNumber: "21/110/00000" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await dbInternal.documentSettings.upsert({ where: { orgId }, create: { orgId, fxRateSource: "BMF_MONTHLY" }, update: { fxRateSource: "BMF_MONTHLY" } });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2110 } },
    create: { orgId, docType: "INVOICE", year: 2110, currentValue: 0, prefix: "FXL-", pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: {},
  });
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "Overseas Ltd", addressLine1: "1 Main Street", postalCode: "10001", city: "Dublin", type: "BUSINESS" } })).id;
  await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2110-03-01", rate: "1,1214" }), "test", orgId);
});

const draft = (currency: string, language?: string) =>
  createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId, type: "INVOICE", taxScheme: "REGULAR", currency, issueDate: NOW, deliveryDate: DELIVERY, ...(language ? { language } : {}),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 11214, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );

describe("loadEInvoiceData: EUR-Block", () => {
  it("Entwurf in USD: Vorschau mit Live-Kurs, markiert als preview", async () => {
    const d = await draft("USD");
    const loaded = await loadEInvoiceData(d.id);
    expect(loaded?.data.fx).toMatchObject({ rateMicros: 1121400, source: "BMF_MONTHLY", taxTotalEurCents: 1900, netTotalEurCents: 10000, preview: true });
  });

  it("festgeschriebener Beleg: eingefrorener Snapshot (ohne preview) -> BT-6/BT-111 im XML", async () => {
    const d = await draft("USD");
    await finalizeInvoice(d.id, { now: NOW });
    const loaded = await loadEInvoiceData(d.id);
    expect(loaded?.data.fx).toMatchObject({ rateMicros: 1121400, taxTotalEurCents: 1900 });
    expect(loaded?.data.fx?.preview).toBeUndefined();
    const xml = buildXRechnungUBL(loaded!.data);
    expect(xml).toContain("<cbc:TaxCurrencyCode>EUR</cbc:TaxCurrencyCode>");
    expect(xml).toContain('<cbc:TaxAmount currencyID="EUR">19.00</cbc:TaxAmount>');
  });

  it("EUR-Beleg: kein EUR-Block", async () => {
    const d = await draft("EUR");
    expect((await loadEInvoiceData(d.id))?.data.fx).toBeNull();
  });

  it("Entwurf in CHF ohne Kurs: Vorschau scheitert nicht, kein EUR-Block", async () => {
    const d = await draft("CHF");
    expect((await loadEInvoiceData(d.id))?.data.fx).toBeNull();
  });
});
