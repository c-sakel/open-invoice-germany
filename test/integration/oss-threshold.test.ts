/**
 * Phase 16e, Task 4 — Loader `ossThreshold` gegen die echten Domain-Services (festgeschriebene
 * Belege, Gutschrift, Storno, Abschlag/Schlussrechnung, Fremdwaehrung). Eigene Testjahre 2115 + 2116
 * (Invoice.number ist global eindeutig; jede Org bekommt ein eigenes Nummernpraefix).
 */
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { createBusinessDocument } from "@/domain/document/create";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { createProduct } from "@/domain/product/save";
import { saveDocumentSettings, loadDocumentSettings } from "@/domain/document/settings";
import { ossThreshold } from "@/domain/reporting/oss";
import { OSS_NOTICE } from "@/schemas/oss";
import { createInvoiceSchema, createDocumentSchema, partialCreditSchema } from "@/schemas";

const NOW = new Date("2116-05-10T10:00:00.000Z");
let seq = 0;

interface Ctx {
  orgId: string;
  at: string;
  atVat: string;
  ch: string;
  de: string;
}

async function mk(mode: "ALL_EU_B2C" | "BY_PRODUCT" = "ALL_EU_B2C"): Promise<Ctx> {
  seq += 1;
  const tag = `OT${seq}`;
  const org = await dbInternal.organization.create({
    data: { legalName: `OSS-Schwelle ${tag} GmbH`, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: `DE2115${String(seq).padStart(5, "0")}`, taxNumber: "21/115/00000" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const year of [2114, 2115, 2116]) {
    for (const docType of ["INVOICE", "CREDIT_NOTE"]) {
      await dbInternal.numberRange.upsert({
        where: { orgId_docType_year: { orgId, docType, year } },
        create: { orgId, docType, year, currentValue: 0, prefix: `${tag}${docType === "INVOICE" ? "R" : "G"}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
        update: {},
      });
    }
  }
  const base = await loadDocumentSettings(orgId);
  await saveDocumentSettings(orgId, { ...base, ossCountMode: mode });
  const cust = async (name: string, countryCode: string, vatId: string | null) =>
    (await dbInternal.customer.create({ data: { orgId, name, addressLine1: "Weg 1", postalCode: "1010", city: "Ort", countryCode, vatId, type: vatId ? "BUSINESS" : "PRIVATE" } })).id;
  return { orgId, at: await cust("AT privat", "AT", null), atVat: await cust("AT Firma", "AT", "ATU12345678"), ch: await cust("CH privat", "CH", null), de: await cust("DE privat", "DE", null) };
}

type LineIn = Record<string, unknown>;
const line = (netCents: number, extra: LineIn = {}): LineIn => ({ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, ...extra });

async function invoice(orgId: string, customerId: string, opts: { netCents?: number; lines?: LineIn[]; now?: Date; delivery?: Date; currency?: string; fx?: string; discountPermille?: number } = {}) {
  const now = opts.now ?? NOW;
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId, type: "INVOICE", taxScheme: "REGULAR", currency: opts.currency ?? "EUR", issueDate: now, deliveryDate: opts.delivery ?? now,
      ...(opts.fx ? { fxOverrideRate: opts.fx } : {}),
      ...(opts.discountPermille ? { documentDiscountPermille: opts.discountPermille } : {}),
      lines: opts.lines ?? [line(opts.netCents ?? 100000)],
    }),
    { now },
  );
  return finalizeInvoice(d.id, { now });
}

describe("ossThreshold", () => {
  it("zaehlt nur EU-B2C ohne USt-IdNr. (AT), nicht AT mit USt-IdNr., CH, DE", async () => {
    const c = await mk();
    await invoice(c.orgId, c.at, { netCents: 400000 });
    await invoice(c.orgId, c.atVat, { netCents: 500000 });
    await invoice(c.orgId, c.ch, { netCents: 500000 });
    await invoice(c.orgId, c.de, { netCents: 500000 });
    const r = await ossThreshold(c.orgId, 2116);
    expect(r.current.netEurCents).toBe(400000);
    expect(r.current.byCountry).toEqual([{ countryCode: "AT", netEurCents: 400000 }]);
    expect(r.current.documentCount).toBe(1);
    expect(r.notice).toBe(OSS_NOTICE);
    expect(r.thresholdCents).toBe(1_000_000);
    expect(r.level).toBe("OK");
  });

  it("nutzt den Snapshot, nicht den Kundenstamm", async () => {
    const c = await mk();
    await invoice(c.orgId, c.at, { netCents: 400000 });
    await dbInternal.customer.update({ where: { id: c.at }, data: { countryCode: "DE" } });
    expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(400000);
  });

  it("Teilgutschrift zieht ab, Storno hebt den Beleg auf", async () => {
    const c = await mk();
    const first = await invoice(c.orgId, c.at, { netCents: 400000 });
    await createPartialCreditNote(first.id, partialCreditSchema.parse({ lines: [{ description: "Gutschrift", quantityMilli: 1000, unitNetPriceCents: 100000, taxRate: 19 }] }), { orgId: c.orgId, now: NOW });
    expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(300000);
    const second = await invoice(c.orgId, c.at, { netCents: 250000 });
    expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(550000);
    await cancelInvoice(second.id, { orgId: c.orgId, now: NOW });
    expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(300000);
  });

  async function quote(c: Ctx) {
    return createBusinessDocument(c.orgId, createDocumentSchema.parse({ kind: "ANGEBOT", customerId: c.at, taxScheme: "REGULAR", lines: [line(1000000)] }), { now: NOW });
  }

  it("Abschlag + Schlussrechnung zaehlen zusammen den Gesamtbetrag; Storno der Schlussrechnung laesst den Abschlag", async () => {
    const c = await mk();
    const q = await quote(c);
    const feb = new Date("2116-02-10T10:00:00.000Z");
    const dp = await createDownpaymentInvoice(c.orgId, { sourceType: "QUOTE", sourceId: q.id, mode: "PERCENT", permille: 300 }, { now: feb });
    await finalizeInvoice(dp.id, { now: feb });
    const fin = await createFinalInvoice(c.orgId, { sourceType: "QUOTE", sourceId: q.id }, { now: NOW });
    const finalized = await finalizeInvoice(fin.id, { now: NOW });
    expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(1000000);
    await cancelInvoice(finalized.id, { orgId: c.orgId, now: NOW });
    expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(300000);
  });

  it("Schlussrechnung 2116 mit Abschlag aus 2114 (ausserhalb des Fensters): Abschlag wird nachgeladen", async () => {
    const c = await mk();
    const q = await quote(c);
    const dec = new Date("2114-12-10T10:00:00.000Z");
    const dp = await createDownpaymentInvoice(c.orgId, { sourceType: "QUOTE", sourceId: q.id, mode: "PERCENT", permille: 300 }, { now: dec });
    await finalizeInvoice(dp.id, { now: dec });
    const fin = await createFinalInvoice(c.orgId, { sourceType: "QUOTE", sourceId: q.id }, { now: NOW });
    await finalizeInvoice(fin.id, { now: NOW });
    const r = await ossThreshold(c.orgId, 2116);
    expect(r.current.netEurCents).toBe(700000);
    expect(r.previous.netEurCents).toBe(0);
  });

  it("USD mit Kurs 1,25 -> EUR; Altbeleg ohne EUR-Betrag wird gemeldet statt als 0 gezaehlt", async () => {
    const c = await mk();
    await invoice(c.orgId, c.at, { netCents: 1250000, currency: "USD", fx: "1,25" });
    expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(1000000);
    const legacy = await invoice(c.orgId, c.at, { netCents: 1250000, currency: "USD", fx: "1,25" });
    // Testaufbau: Altbeleg vor 16b simulieren; dbInternal umgeht den GoBD-Guard bewusst.
    await dbInternal.invoice.update({ where: { id: legacy.id }, data: { netTotalEurCents: null, fxRateMicros: null } });
    const r = await ossThreshold(c.orgId, 2116);
    expect(r.current.skippedWithoutEur).toBe(1);
    expect(r.current.netEurCents).toBe(1000000);
  });

  it("R6: Leistung Dezember 2115, Rechnung Januar 2116 zaehlt im Vorjahr", async () => {
    const c = await mk();
    await invoice(c.orgId, c.at, { netCents: 200000, now: new Date("2116-01-10T10:00:00.000Z"), delivery: new Date("2115-12-15T00:00:00.000Z") });
    const r = await ossThreshold(c.orgId, 2116);
    expect(r.previous.netEurCents).toBe(200000);
    expect(r.current.netEurCents).toBe(0);
  });

  it("Vorjahr strikt ueber 10.000 EUR -> EXCEEDED, genau 10.000 EUR nicht", async () => {
    const c = await mk();
    await invoice(c.orgId, c.at, { netCents: 1000001, now: new Date("2115-06-10T10:00:00.000Z") });
    const r = await ossThreshold(c.orgId, 2116);
    expect(r.level).toBe("EXCEEDED");
    expect(r.previousYearExceeded).toBe(true);
    const e = await mk();
    await invoice(e.orgId, e.at, { netCents: 1000000, now: new Date("2115-06-10T10:00:00.000Z") });
    const re = await ossThreshold(e.orgId, 2116);
    expect(re.previousYearExceeded).toBe(false);
    expect(re.level).toBe("OK");
  });

  describe("Modus BY_PRODUCT", () => {
    it("zaehlt nur OSS-Positionen (Belegrabatt anteilig), Zeile mit expliziter Kategorie, Storno kehrt zurueck", async () => {
      const c = await mk("BY_PRODUCT");
      const productId = (await createProduct(c.orgId, { name: "E-Dienst", netPriceCents: 60000, ossCategory: "ELECTRONIC_SERVICE" })).id;
      const inv = await invoice(c.orgId, c.at, { lines: [line(60000, { productId }), line(40000)], discountPermille: 100 });
      expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(54000);
      await invoice(c.orgId, c.at, { lines: [line(20000, { ossCategory: "GOODS_DISTANCE" })] });
      expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(74000);
      await cancelInvoice(inv.id, { orgId: c.orgId, now: NOW });
      expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(20000);
    });

    it("Teilgutschrift zaehlt anteilig nach dem OSS-Anteil des Originals", async () => {
      const c = await mk("BY_PRODUCT");
      const productId = (await createProduct(c.orgId, { name: "E-Dienst", netPriceCents: 60000, ossCategory: "ELECTRONIC_SERVICE" })).id;
      const inv = await invoice(c.orgId, c.at, { lines: [line(60000, { productId }), line(40000)] });
      await createPartialCreditNote(inv.id, partialCreditSchema.parse({ lines: [{ description: "Gutschrift", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19 }] }), { orgId: c.orgId, now: NOW });
      expect((await ossThreshold(c.orgId, 2116)).current.netEurCents).toBe(54000);
    });
  });

  it("Fremde Organisation beeinflusst das Ergebnis nicht", async () => {
    const a = await mk();
    const b = await mk();
    await invoice(b.orgId, b.at, { netCents: 900000 });
    expect((await ossThreshold(a.orgId, 2116)).current.netEurCents).toBe(0);
  });
});
