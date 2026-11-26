/**
 * Skonto auf dem Zahlbetrag einer Schlussrechnung: Festschreiben, PDF-Text, E-Rechnung (UBL + CII),
 * Bankabgleich, Zahlungsbuchung, Bestand und REST. Testjahr 2280.
 * Schlussrechnung 11.900,00 EUR brutto, Abschlaege 5.950,00 EUR, Skonto 2 % / 7 Tage.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));

import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBusinessDocument } from "@/domain/document/create";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { loadMatchContext } from "@/domain/bank/suggest";
import { suggestMatches, type MatchTransaction } from "@/domain/bank/match";
import { GET as skontoCheckGet } from "@/app/api/invoices/[id]/skonto-check/route";
import { serializeInvoice } from "@/api/serializers/invoice";
import { createInvoiceSchema, recordPaymentSchema } from "@/schemas";

const NOW = new Date("2280-05-02T10:00:00.000Z");
const IN_TIME = new Date("2280-05-06T10:00:00.000Z");
const STAGE2_TIME = new Date("2280-05-14T10:00:00.000Z");
const TOO_LATE = new Date("2280-06-20T10:00:00.000Z");

let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Skonto Schluss GmbH", addressLine1: "Kursweg 1", postalCode: "10115", city: "Berlin", vatId: "DE123456789", taxNumber: "21/228/00000" },
    select: { id: true },
  });
  orgId = org.id;
  orgStore.id = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 0 } },
    create: { orgId, docType: "INVOICE", year: 0, currentValue: 0, prefix: `SK2280-${orgId.slice(-6)}-`, pattern: "{PREFIX}{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix: `SK2280-${orgId.slice(-6)}-`, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "INVOICE", year: { not: 0 } }, data: { isActive: false } });
  const c = await dbInternal.customer.create({
    data: { orgId, name: "Muster Kundschaft GmbH", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    select: { id: true },
  });
  customerId = c.id;
});

async function finalWithSkonto(opts: { currency?: string; stage2?: boolean } = {}): Promise<{ id: string; number: string }> {
  const quote = await createBusinessDocument(
    orgId,
    {
      kind: "ANGEBOT",
      customerId,
      taxScheme: "REGULAR",
      currency: opts.currency ?? "EUR",
      lines: [{ lineType: "ITEM", description: "Projekt", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1_000_000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    },
    { now: NOW },
  );
  for (let i = 0; i < 2; i++) {
    const dp = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id, mode: "PERCENT", permille: 250 }, { now: NOW });
    await finalizeInvoice(dp.id, { now: NOW });
  }
  const final = await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id }, { now: NOW });
  await dbInternal.invoice.update({ where: { id: final.id }, data: { skonto1Permille: 20, skonto1Days: 7, ...(opts.stage2 ? { skonto2Permille: 10, skonto2Days: 14 } : {}) } });
  const fin = await finalizeInvoice(final.id, { now: NOW });
  return { id: fin.id, number: fin.number! };
}

async function normalWithSkonto(): Promise<{ id: string; grossTotalCents: number }> {
  const draft = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: NOW,
      skonto1Permille: 20,
      skonto1Days: 7,
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  const fin = await finalizeInvoice(draft.id, { now: NOW });
  return { id: fin.id, grossTotalCents: fin.grossTotalCents };
}

async function xmlOf(id: string): Promise<{ ubl: string; cii: string; human: string | null | undefined }> {
  const loaded = await loadEInvoiceData(id);
  if (!loaded) throw new Error("Beleg nicht gefunden");
  return { ubl: buildXRechnungUBL(loaded.data), cii: buildFacturXCII(loaded.data), human: loaded.data.paymentTermsHuman };
}

function bankTx(remittance: string, amountCents: number, bookingDate: Date, currency = "EUR"): MatchTransaction {
  return {
    bookingDate,
    amountCents,
    allocatedCents: 0,
    currency,
    direction: "CRDT",
    counterpartyName: null,
    counterpartyIbanHash: null,
    remittance,
    endToEndId: null,
  };
}

async function skontoSuggestion(number: string, amountCents: number, at: Date, currency = "EUR"): Promise<boolean | null> {
  const ctx = await loadMatchContext(orgId);
  const s = suggestMatches(bankTx(number, amountCents, at, currency), ctx).find((x) => x.allocations.some((a) => a.number === number));
  return s ? (s.allocations[0]?.applySkonto ?? false) : null;
}

describe("Schlussrechnung mit Skonto", () => {
  it("friert die Skonto-Basis beim Festschreiben ein, PDF-Text und XML rechnen auf dem Zahlbetrag", async () => {
    const f = await finalWithSkonto();
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: f.id }, select: { skontoBaseCents: true, payableCents: true, grossTotalCents: true } });
    expect(row.grossTotalCents).toBe(1_190_000);
    expect(row.payableCents).toBe(595_000);
    expect(row.skontoBaseCents).toBe(595_000);
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { entityId: f.id, action: "FINALIZE" }, select: { diffJson: true } });
    expect((JSON.parse(log.diffJson) as Record<string, unknown>).skontoBaseCents).toBe(595_000);

    const { ubl, cii, human } = await xmlOf(f.id);
    expect(human).toContain("119,00");
    expect(human).not.toContain("238,00");
    expect(ubl).toContain("#SKONTO#TAGE=7#PROZENT=2.00#\n");
    expect(ubl).not.toContain("BASISBETRAG");
    expect(cii).toContain("#SKONTO#TAGE=7#PROZENT=2.00#\n");
    expect(cii).not.toContain("BASISBETRAG");
  });

  it("Bankabgleich schlaegt Skonto auf dem Zahlbetrag vor, nicht ausserhalb", async () => {
    const f = await finalWithSkonto();
    expect(await skontoSuggestion(f.number, 583_100, IN_TIME)).toBe(true);
    expect(await skontoSuggestion(f.number, 571_200, IN_TIME)).not.toBe(true);
    expect(await skontoSuggestion(f.number, 583_100, TOO_LATE)).not.toBe(true);
  });

  it("Zahlung mit applySkonto schliesst die Rechnung, Vorschau stimmt", async () => {
    const f = await finalWithSkonto();
    const check = await skontoCheckGet(new Request(`http://localhost/x?amountCents=583100&paidAt=${IN_TIME.toISOString()}`), { params: Promise.resolve({ id: f.id }) });
    expect((await check.json()).suggestion.amountCents).toBe(11_900);
    const r = await recordPayment(f.id, recordPaymentSchema.parse({ amountCents: 583_100, method: "TRANSFER", paidAt: IN_TIME, applySkonto: true }));
    expect(r.payment.status).toBe("PAID");
    expect(r.skontoPayment?.amountCents).toBe(11_900);
  });

  it("Bestand (Basis = Gesamtbrutto eingefroren) bleibt wie ausgegeben", async () => {
    const f = await finalWithSkonto();
    await dbInternal.invoice.update({ where: { id: f.id }, data: { skontoBaseCents: 1_190_000 } });
    const { ubl, cii, human } = await xmlOf(f.id);
    expect(human).toContain("238,00");
    expect(ubl).toContain("#SKONTO#TAGE=7#PROZENT=2.00#BASISBETRAG=11900.00#");
    expect(cii).toContain("#SKONTO#TAGE=7#PROZENT=2.00#BASISBETRAG=11900.00#");
    expect(await skontoSuggestion(f.number, 571_200, IN_TIME)).toBe(true);
    const check = await skontoCheckGet(new Request(`http://localhost/x?amountCents=571200&paidAt=${IN_TIME.toISOString()}`), { params: Promise.resolve({ id: f.id }) });
    expect((await check.json()).suggestion).not.toBeNull();
    const r = await recordPayment(f.id, recordPaymentSchema.parse({ amountCents: 571_200, method: "TRANSFER", paidAt: IN_TIME, applySkonto: true }));
    expect(r.payment.status).toBe("PAID");
    expect(r.skontoPayment?.amountCents).toBe(23_800);
  });

  it("Fremdwaehrung: Skonto-Basis, Zahlbetrag und Vorschlag auf dem Zahlbetrag in USD", async () => {
    for (const [source, day] of [["MONTHLY", "2280-04-01"], ["MONTHLY", "2280-05-01"], ["ECB", "2280-05-01"]] as const) {
      await dbInternal.exchangeRate.create({ data: { source, currency: "USD", rateDate: new Date(`${day}T00:00:00.000Z`), rateMicros: 1100000, origin: "COMPUTED" } });
    }
    const f = await finalWithSkonto({ currency: "USD" });
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: f.id }, select: { currency: true, skontoBaseCents: true, payableCents: true } });
    expect(row.currency).toBe("USD");
    expect(row.payableCents).toBe(595_000);
    expect(row.skontoBaseCents).toBe(595_000);
    expect(await skontoSuggestion(f.number, 583_100, IN_TIME, "USD")).toBe(true);
    expect(await skontoSuggestion(f.number, 571_200, IN_TIME, "USD")).not.toBe(true);
    const r = await recordPayment(f.id, recordPaymentSchema.parse({ amountCents: 583_100, method: "TRANSFER", paidAt: IN_TIME, applySkonto: true }));
    expect(r.payment.status).toBe("PAID");
    expect(r.skontoPayment?.amountCents).toBe(11_900);
  });

  it("Skonto-Stufe 2 (1 % / 14 Tage) rechnet auf dem Zahlbetrag, Stufe 1 ist dann abgelaufen", async () => {
    const f = await finalWithSkonto({ stage2: true });
    // 12 Tage nach Ausstellung: nur Stufe 2 gilt, 1 % von 5.950,00 EUR = 59,50 EUR
    const check = await skontoCheckGet(new Request(`http://localhost/x?amountCents=589050&paidAt=${STAGE2_TIME.toISOString()}`), { params: Promise.resolve({ id: f.id }) });
    expect((await check.json()).suggestion.amountCents).toBe(5_950);
    expect(await skontoSuggestion(f.number, 589_050, STAGE2_TIME)).toBe(true);
    // der Stufe-1-Betrag (2 %) reicht nach Ablauf der 7 Tage nicht fuer Skonto
    expect(await skontoSuggestion(f.number, 583_100, STAGE2_TIME)).not.toBe(true);
    const r = await recordPayment(f.id, recordPaymentSchema.parse({ amountCents: 589_050, method: "TRANSFER", paidAt: STAGE2_TIME, applySkonto: true }));
    expect(r.payment.status).toBe("PAID");
    expect(r.skontoPayment?.amountCents).toBe(5_950);
  });

  it("REST-Serialisierung nennt skontoBaseCents", async () => {
    const f = await finalWithSkonto();
    const inv = await dbInternal.invoice.findUniqueOrThrow({ where: { id: f.id }, include: { lines: true } });
    expect(serializeInvoice(inv, new Set()).skontoBaseCents).toBe(595_000);
  });
});

describe("Normale Rechnung mit Skonto", () => {
  it("ohne Zahlung: Zeile ohne BASISBETRAG (unveraendert)", async () => {
    const n = await normalWithSkonto();
    const { ubl, cii } = await xmlOf(n.id);
    expect(ubl).toContain("#SKONTO#TAGE=7#PROZENT=2.00#\n");
    expect(ubl).not.toContain("BASISBETRAG");
    expect(cii).not.toContain("BASISBETRAG");
  });

  it("nach Teilzahlung neu erzeugt: BASISBETRAG = Brutto (Basis weicht von BT-115 ab)", async () => {
    const n = await normalWithSkonto();
    await recordPayment(n.id, recordPaymentSchema.parse({ amountCents: 20_000, method: "TRANSFER", paidAt: IN_TIME }));
    const { ubl, cii } = await xmlOf(n.id);
    const expected = `#SKONTO#TAGE=7#PROZENT=2.00#BASISBETRAG=${(n.grossTotalCents / 100).toFixed(2)}#`;
    expect(ubl).toContain(expected);
    expect(cii).toContain(expected);
  });
});
