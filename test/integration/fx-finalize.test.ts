/**
 * Phase 16b, Task 4: Kurs-Snapshot beim Festschreiben (§ 16 Abs. 6 UStG).
 *  - EUR-Beleg ohne Kurs, EUR-Summen = Belegsummen,
 *  - USD mit Monatskurs (BMF_MONTHLY), Tageskurs (ECB_DAILY) und Entwurfs-Override (MANUAL),
 *  - spaetere Kursaenderung laesst den festgeschriebenen Beleg unveraendert,
 *  - fehlender Kurs -> FinalizeError bzw. REST 422,
 *  - Storno/Teilgutschrift uebernehmen den Kurs des Originals.
 *
 * Eigenes Testjahr (2109): Invoice.number ist global @unique; ExchangeRate ist instanzweit.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { z } from "zod";
import { dbInternal, prisma } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice, FinalizeError } from "@/domain/invoice/finalize";
import { updateDraftInvoice, InvoiceUpdateError } from "@/domain/invoice/update";
import { cancelInvoice, CancelError } from "@/domain/invoice/cancel";
import { createBusinessDocument } from "@/domain/document/create";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { loadDeductedTaxEurCents, FxRateError } from "@/domain/fx/snapshot";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { upsertManualRate } from "@/domain/fx/store";
import { createApiKey } from "@/domain/api-key/create";
import { resetRateLimits } from "@/lib/rate-limit";
import { createInvoiceSchema, cancelInvoiceSchema, partialCreditSchema } from "@/schemas";
import { exchangeRateUpsertSchema } from "@/schemas/fx";
import { POST as InvoiceFinalize } from "@/app/api/v1/Invoice/[id]/finalize/route";

const NOW = new Date("2109-03-20T10:00:00.000Z");
const DELIVERY = new Date("2109-03-12T00:00:00.000Z");
const MARCH = new Date("2109-03-01T00:00:00.000Z");
const MISSING_MESSAGE = "Kein Wechselkurs für USD zum 12.03.2109 — Kurs manuell eintragen.";

let orgId: string;
let ecbOrgId: string;
let customerId: string;
let ecbCustomerId: string;

async function makeOrg(legalName: string, vatId: string, fxRateSource: string, prefix: string) {
  const org = await dbInternal.organization.create({
    data: { legalName, addressLine1: "Kursweg 1", postalCode: "10115", city: "Berlin", vatId, taxNumber: "21/109/00000" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await dbInternal.documentSettings.upsert({ where: { orgId: org.id }, create: { orgId: org.id, fxRateSource }, update: { fxRateSource } });
  for (const docType of ["INVOICE", "CREDIT_NOTE"]) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId: org.id, docType, year: 2109 } },
      create: { orgId: org.id, docType, year: 2109, currentValue: 0, prefix: `${prefix}${docType === "INVOICE" ? "R" : "G"}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: {},
    });
  }
  const customer = await dbInternal.customer.create({
    data: { orgId: org.id, name: "Overseas Ltd", addressLine1: "1 Main Street", postalCode: "10001", city: "Dublin", type: "BUSINESS" },
  });
  return { orgId: org.id, customerId: customer.id };
}

beforeAll(async () => {
  ({ orgId, customerId } = await makeOrg("Kurs GmbH", "DE210921091", "BMF_MONTHLY", "FXB"));
  ({ orgId: ecbOrgId, customerId: ecbCustomerId } = await makeOrg("Tageskurs GmbH", "DE210921092", "ECB_DAILY", "FXE"));
});

// Netto 112,14 USD @ 19 % -> USt 21,31 USD
async function draft(opts: { org?: string; customer?: string; currency?: string; fxOverrideRate?: string; netCents?: number; deliveryDate?: Date } = {}) {
  return createDraftInvoice(
    opts.org ?? orgId,
    createInvoiceSchema.parse({
      customerId: opts.customer ?? customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: opts.currency ?? "USD",
      issueDate: NOW,
      deliveryDate: opts.deliveryDate ?? DELIVERY,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      ...(opts.fxOverrideRate !== undefined ? { fxOverrideRate: opts.fxOverrideRate } : {}),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: opts.netCents ?? 11214, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
}

const fxOf = (id: string) =>
  dbInternal.invoice.findUniqueOrThrow({
    where: { id },
    select: { fxRateMicros: true, fxRateDate: true, fxRateSource: true, fxOverrideMicros: true, taxTotalEurCents: true, netTotalEurCents: true, taxTotalCents: true, netTotalCents: true, status: true },
  });

describe("Kurs-Snapshot beim Festschreiben", () => {
  it("EUR-Rechnung: kein Kurs, EUR-Summen = Belegsummen", async () => {
    const d = await draft({ currency: "EUR" });
    await finalizeInvoice(d.id, { now: NOW });
    const fx = await fxOf(d.id);
    expect(fx.fxRateMicros).toBeNull();
    expect(fx.fxRateDate).toBeNull();
    expect(fx.fxRateSource).toBeNull();
    expect(fx.taxTotalEurCents).toBe(fx.taxTotalCents);
    expect(fx.netTotalEurCents).toBe(fx.netTotalCents);
  });

  it("ohne Kurs: FinalizeError mit exaktem Text, keine Nummer, REST 422", async () => {
    const d = await draft();
    const err = await finalizeInvoice(d.id, { now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FinalizeError);
    expect((err as Error).message).toBe(MISSING_MESSAGE);
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: d.id }, select: { status: true, number: true, fxRateMicros: true } });
    expect(after).toEqual({ status: "DRAFT", number: null, fxRateMicros: null });

    resetRateLimits();
    const token = (await createApiKey(orgId, { name: "FX-Key", scopes: ["read", "write"] })).token;
    const res = await InvoiceFinalize(
      new Request(`http://x/api/v1/Invoice/${d.id}/finalize`, { method: "POST", headers: { authorization: `Bearer ${token}` } }),
      { params: Promise.resolve({ id: d.id }) },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNPROCESSABLE");
    expect(body.error.message).toMatch(/^Kein Wechselkurs für USD zum \d{2}\.\d{2}\.\d{4} — Kurs manuell eintragen\.$/);
  });

  describe("mit Kurstabelle", () => {
    let usdId: string;

    beforeAll(async () => {
      await dbInternal.exchangeRate.create({ data: { source: "MONTHLY", currency: "USD", rateDate: MARCH, rateMicros: 1121400, origin: "COMPUTED" } });
      await dbInternal.exchangeRate.create({ data: { source: "ECB", currency: "USD", rateDate: new Date("2109-03-11T00:00:00.000Z"), rateMicros: 1100000, origin: "COMPUTED" } });
    });

    it("USD + BMF_MONTHLY: Monatskurs Maerz, EUR-Summen eingefroren", async () => {
      const d = await draft();
      usdId = d.id;
      await finalizeInvoice(d.id, { now: NOW });
      const fx = await fxOf(d.id);
      expect(fx.taxTotalCents).toBe(2131);
      expect(fx.fxRateMicros).toBe(1121400);
      expect(fx.fxRateSource).toBe("BMF_MONTHLY");
      expect(fx.fxRateDate?.toISOString()).toBe(MARCH.toISOString());
      expect(fx.netTotalEurCents).toBe(10000);
      expect(fx.taxTotalEurCents).toBe(1900);
    });

    it("Kursaenderung nach dem Festschreiben aendert den Beleg nicht; ChangeLog traegt den Kurs", async () => {
      await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2109-03-01", rate: "1,2" }), "test", orgId);
      const fx = await fxOf(usdId);
      expect(fx.fxRateMicros).toBe(1121400);
      expect(fx.taxTotalEurCents).toBe(1900);
      const log = await dbInternal.changeLog.findFirstOrThrow({ where: { entityId: usdId, action: "FINALIZE" }, select: { diffJson: true } });
      const diff = JSON.parse(log.diffJson) as Record<string, unknown>;
      expect(diff.fxRateMicros).toBe(1121400);
      expect(diff.taxTotalEurCents).toBe(1900);
      expect(diff.fxRateSource).toBe("BMF_MONTHLY");
    });

    it("Storno uebernimmt Kurs/Quelle/Datum des Originals, EUR-Steuer hebt sich exakt auf", async () => {
      const res = await cancelInvoice(usdId, { orgId, now: NOW });
      const credit = await fxOf(res.creditNote.id);
      const original = await fxOf(usdId);
      expect(credit.fxRateMicros).toBe(1121400);
      expect(credit.fxRateSource).toBe("BMF_MONTHLY");
      expect(credit.fxRateDate?.toISOString()).toBe(MARCH.toISOString());
      expect(credit.taxTotalEurCents).toBe(-1900);
      expect(credit.netTotalEurCents).toBe(-10000);
      expect((original.taxTotalEurCents ?? 0) + (credit.taxTotalEurCents ?? 0)).toBe(0);
      expect((original.netTotalEurCents ?? 0) + (credit.netTotalEurCents ?? 0)).toBe(0);
    });

    it("Teilgutschrift nutzt den Original-Kurs, obwohl die Tabelle inzwischen 1,2 sagt", async () => {
      // Original mit Override 1,1214 (Tabelle steht auf 1,2): Teilgutschrift muss 1,1214 nehmen.
      const d = await draft({ fxOverrideRate: "1,1214" });
      await finalizeInvoice(d.id, { now: NOW });
      const res = await createPartialCreditNote(
        d.id,
        { lines: [{ description: "Teilgutschrift", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 5607, taxRate: 19, taxCategory: "S" }] },
        { orgId, now: NOW },
      );
      const credit = await fxOf(res.creditNote.id);
      expect(credit.fxRateMicros).toBe(1121400);
      expect(credit.fxRateSource).toBe("MANUAL");
      expect(credit.fxOverrideMicros).toBeNull();
      expect(credit.taxTotalCents).toBe(-1065);
      expect(credit.taxTotalEurCents).toBe(-950); // 1065 / 1,1214 = 949,70; mit 1,2 waeren es 888
      expect(credit.netTotalEurCents).toBe(-5000);
    });

    it("Teilgutschrift einer Tabellenkurs-Rechnung: Original-Monatskurs statt geaendertem Tabellenwert", async () => {
      // Rechnung festgeschrieben mit 1,2 (aktueller Tabellenwert), dann Tabelle auf 1,1214 zurueck.
      const d = await draft({ netCents: 12000 });
      await finalizeInvoice(d.id, { now: NOW });
      expect((await fxOf(d.id)).fxRateMicros).toBe(1200000);
      await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2109-03-01", rate: "1,1214" }), "test", orgId);
      const res = await createPartialCreditNote(
        d.id,
        { lines: [{ description: "Teilgutschrift", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 6000, taxRate: 19, taxCategory: "S" }] },
        { orgId, now: NOW },
      );
      const credit = await fxOf(res.creditNote.id);
      expect(credit.fxRateMicros).toBe(1200000);
      expect(credit.fxRateSource).toBe("BMF_MONTHLY");
      expect(credit.netTotalEurCents).toBe(-5000);
      expect(credit.taxTotalEurCents).toBe(-950); // 1140 / 1,2
    });

    it("Entwurfs-Override '1,25' -> MANUAL, Kursdatum = Stichtag; auf FINALIZED kein Schreiben", async () => {
      const d = await draft();
      const updated = await updateDraftInvoice(orgId, d.id, { fxOverrideRate: "1,25" }, "test");
      expect(updated.fxOverrideMicros).toBe(1250000);
      await finalizeInvoice(d.id, { now: NOW });
      const fx = await fxOf(d.id);
      expect(fx.fxRateMicros).toBe(1250000);
      expect(fx.fxRateSource).toBe("MANUAL");
      expect(fx.fxRateDate?.toISOString()).toBe(DELIVERY.toISOString());
      expect(fx.netTotalEurCents).toBe(8971); // 11214 / 1,25 = 8971,2
      expect(fx.taxTotalEurCents).toBe(1705); // 2131 / 1,25 = 1704,8

      await expect(updateDraftInvoice(orgId, d.id, { fxOverrideRate: "2" }, "test")).rejects.toBeInstanceOf(InvoiceUpdateError);
      const after = await fxOf(d.id);
      expect(after.fxOverrideMicros).toBe(1250000);
      expect(after.fxRateMicros).toBe(1250000);
    });

    it("Override im Entwurf mit null loeschen -> Tabellenkurs", async () => {
      const d = await draft({ fxOverrideRate: "1,5" });
      expect((await fxOf(d.id)).fxOverrideMicros).toBe(1500000);
      await updateDraftInvoice(orgId, d.id, { fxOverrideRate: null }, "test");
      expect((await fxOf(d.id)).fxOverrideMicros).toBeNull();
      await finalizeInvoice(d.id, { now: NOW });
      const fx = await fxOf(d.id);
      expect(fx.fxRateSource).toBe("BMF_MONTHLY");
      expect(fx.fxRateMicros).toBe(1121400);
    });

    it("Override ueber 2000 je EUR wird an der Boundary abgelehnt", () => {
      expect(() => createInvoiceSchema.parse({ customerId, currency: "USD", fxOverrideRate: "2000,5", lines: [{ description: "x", quantityMilli: 1000, unitNetPriceCents: 1, taxRate: 19 }] })).toThrow(/2000/);
    });

    it("Org-Quelle ECB_DAILY: Tageskurs vom Vortag", async () => {
      const d = await draft({ org: ecbOrgId, customer: ecbCustomerId });
      await finalizeInvoice(d.id, { now: NOW });
      const fx = await fxOf(d.id);
      expect(fx.fxRateSource).toBe("ECB_DAILY");
      expect(fx.fxRateMicros).toBe(1100000);
      expect(fx.fxRateDate?.toISOString()).toBe("2109-03-11T00:00:00.000Z");
      expect(fx.netTotalEurCents).toBe(10195); // 11214 / 1,1 = 10194,5 -> 10195
    });
  });

  describe("Fix-Runde 1", () => {
    // Juli 2109: keine Tabellenkurse -> nur Original-Kurs oder Override koennen greifen.
    const JULY = new Date("2109-07-12T00:00:00.000Z");

    /** Altbeleg vor 16b simulieren: festgeschriebene USD-Rechnung ohne Kurs-Snapshot. */
    async function legacyUsdInvoice() {
      const d = await draft({ fxOverrideRate: "1,3", deliveryDate: JULY });
      await finalizeInvoice(d.id, { now: NOW });
      await dbInternal.invoice.update({
        where: { id: d.id },
        data: { fxRateMicros: null, fxRateDate: null, fxRateSource: null, fxOverrideMicros: null, taxTotalEurCents: null, netTotalEurCents: null },
      });
      return d.id;
    }

    it("Storno eines Altbelegs ohne Kurs: ohne Override 422, mit Override MANUAL", async () => {
      const id = await legacyUsdInvoice();
      // Storno im September: Stichtag Juli liegt in der Vergangenheit, Juni/Juli ohne Tabellenkurs.
      const LATER = new Date("2109-09-20T10:00:00.000Z");
      const err = await cancelInvoice(id, { orgId, now: LATER }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FxRateError);
      expect((err as Error).message).toBe("Kein Wechselkurs für USD zum 12.07.2109 — Kurs manuell eintragen.");
      const input = cancelInvoiceSchema.parse({ fxOverrideRate: "1,25" });
      const res = await cancelInvoice(id, { orgId, now: NOW, fxOverrideRate: input.fxOverrideRate });
      const credit = await fxOf(res.creditNote.id);
      expect(credit.fxRateSource).toBe("MANUAL");
      expect(credit.fxRateMicros).toBe(1250000);
      expect(credit.taxTotalEurCents).toBe(-1705);
    });

    it("Teilgutschrift eines Altbelegs mit Override; Override wird bei vorhandenem Originalkurs ignoriert", async () => {
      const legacy = await legacyUsdInvoice();
      const input = partialCreditSchema.parse({
        lines: [{ description: "Teilgutschrift", quantityMilli: 1000, unitNetPriceCents: 5607, taxRate: 19 }],
        fxOverrideRate: "1,1214",
      });
      const res = await createPartialCreditNote(legacy, input, { orgId, now: NOW });
      const credit = await fxOf(res.creditNote.id);
      expect(credit.fxRateSource).toBe("MANUAL");
      expect(credit.fxRateMicros).toBe(1121400);
      expect(credit.netTotalEurCents).toBe(-5000);

      // Original mit Kurs (1,3): Override 2,0 wird nicht gespeichert, Originalkurs gilt.
      const withRate = await draft({ fxOverrideRate: "1,3", deliveryDate: JULY });
      await finalizeInvoice(withRate.id, { now: NOW });
      const res2 = await createPartialCreditNote(withRate.id, { ...input, fxOverrideRate: 2_000_000 }, { orgId, now: NOW });
      const credit2 = await fxOf(res2.creditNote.id);
      expect(credit2.fxRateMicros).toBe(1300000);
      expect(credit2.fxOverrideMicros).toBeNull();
    });

    it("Vorausrechnung: Leistungsdatum im Folgemonat nimmt den juengsten Monatskurs bis zum Monat von now", async () => {
      const d = await draft({ deliveryDate: new Date("2109-04-15T00:00:00.000Z") });
      await finalizeInvoice(d.id, { now: NOW });
      const fx = await fxOf(d.id);
      expect(fx.fxRateSource).toBe("BMF_MONTHLY");
      expect(fx.fxRateMicros).toBe(1121400);
      expect(fx.fxRateDate?.toISOString()).toBe("2109-03-01T00:00:00.000Z");
    });

    it("Storno einer EUR-Rechnung mit Kurs-Override wird abgelehnt", async () => {
      const d = await draft({ currency: "EUR" });
      await finalizeInvoice(d.id, { now: NOW });
      await expect(cancelInvoice(d.id, { orgId, now: NOW, fxOverrideRate: 1_100_000 })).rejects.toBeInstanceOf(CancelError);
      expect((await fxOf(d.id)).status).toBe("FINALIZED");
    });

    it("fxOverrideRate bei EUR: Anlegen und Bearbeiten abgelehnt, Wechsel auf EUR loescht den Override", async () => {
      await expect(draft({ currency: "EUR", fxOverrideRate: "1,1" })).rejects.toBeInstanceOf(z.ZodError);
      const eur = await draft({ currency: "EUR" });
      await expect(updateDraftInvoice(orgId, eur.id, { fxOverrideRate: "1,1" }, "test")).rejects.toThrow("Wechselkurs nur bei Fremdwährung möglich");
      const usd = await draft({ fxOverrideRate: "1,1" });
      await updateDraftInvoice(orgId, usd.id, { currency: "EUR" }, "test");
      expect((await fxOf(usd.id)).fxOverrideMicros).toBeNull();
    });

    it("Guard: fx-Felder einer FINALIZED-Rechnung sind ueber den geschuetzten Client unveraenderlich", async () => {
      const d = await draft({ fxOverrideRate: "1,3", deliveryDate: JULY });
      await finalizeInvoice(d.id, { now: NOW });
      await expect(prisma.invoice.update({ where: { id: d.id }, data: { fxRateMicros: 1 } })).rejects.toThrow(/GoBD/);
      await expect(prisma.invoice.updateMany({ where: { id: d.id }, data: { taxTotalEurCents: 0 } })).rejects.toThrow(/GoBD/);
      const fx = await fxOf(d.id);
      expect(fx.fxRateMicros).toBe(1300000);
      expect(fx.taxTotalEurCents).toBe(1639); // 2131 / 1,3 = 1639,2
    });

    it("Schlussrechnung in USD: volle Steuer zum Schlusskurs, Abschlags-Steuer je Abschlag zu dessen Kurs", async () => {
      const quote = await createBusinessDocument(
        orgId,
        {
          kind: "ANGEBOT",
          customerId,
          taxScheme: "REGULAR",
          currency: "USD",
          lines: [{ lineType: "ITEM", description: "Projekt", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 1_000_000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
        },
        { now: NOW },
      );
      const dpAt = async (rateMicros: number) => {
        const dp = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id, mode: "PERCENT", permille: 300 }, { now: NOW });
        await dbInternal.invoice.update({ where: { id: dp.id }, data: { fxOverrideMicros: rateMicros } });
        return finalizeInvoice(dp.id, { now: NOW });
      };
      const dp1 = await dpAt(1_200_000);
      const dp2 = await dpAt(1_000_000);
      expect((await fxOf(dp1.id)).taxTotalEurCents).toBe(47500); // 57.000 / 1,2
      expect((await fxOf(dp2.id)).taxTotalEurCents).toBe(57000); // 57.000 / 1,0

      const final = await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id }, { now: NOW });
      await dbInternal.invoice.update({ where: { id: final.id }, data: { fxOverrideMicros: 1_100_000 } });
      await finalizeInvoice(final.id, { now: NOW });
      const fx = await fxOf(final.id);
      expect(fx.taxTotalCents).toBe(190000);
      expect(fx.taxTotalEurCents).toBe(172727); // 190.000 / 1,1 = 172.727,27
      expect(await loadDeductedTaxEurCents(dbInternal, final.id)).toBe(104500);
      const log = await dbInternal.changeLog.findFirstOrThrow({ where: { entityId: final.id, action: "FINALIZE" }, select: { diffJson: true } });
      expect((JSON.parse(log.diffJson) as Record<string, unknown>).deductedTaxEurCents).toBe(104500);
      // Nicht-Schlussrechnung / EUR -> kein Ausweis
      expect(await loadDeductedTaxEurCents(dbInternal, dp1.id)).toBeNull();
    });
  });
});
