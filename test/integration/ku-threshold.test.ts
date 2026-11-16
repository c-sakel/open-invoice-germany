/**
 * Umsatzgrenzen der Kleinunternehmerregelung: Loader `kuThreshold` gegen die echten Domain-Services
 * (festgeschriebene Belege, Zahlungen, Gegenbuchung, Teilgutschrift mit Verrechnung). Testjahr 2228
 * (Invoice.number ist global eindeutig; jede Org bekommt ein eigenes Nummernpraefix).
 */
import { describe, it, expect, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { saveDocumentSettings, loadDocumentSettings } from "@/domain/document/settings";
import { kuThreshold } from "@/domain/reporting/ku";
import { KU_NOTICE } from "@/schemas/small-business";
import { createInvoiceSchema, partialCreditSchema } from "@/schemas";

const NOW = new Date("2228-05-10T10:00:00.000Z");
const PREV = new Date("2227-05-10T10:00:00.000Z");
// Die Einstellungen kennen nur Jahre bis 2099 (Aufnahmejahr) bzw. 20JJ (Fremdumsatz): dafuer ein eigenes Jahr.
const SET_NOW = new Date("2099-05-10T10:00:00.000Z");
const SET_PREV = new Date("2098-05-10T10:00:00.000Z");
let seq = 0;

interface Ctx {
  orgId: string;
  customerId: string;
  now: Date;
}

async function mk(scheme: "KLEINUNTERNEHMER" | "REGULAR" = "REGULAR", now: Date = NOW): Promise<Ctx> {
  seq += 1;
  const year = now.getUTCFullYear();
  const tag = `${now === NOW ? "KT" : "KS"}${seq}`;
  const org = await dbInternal.organization.create({
    data: {
      legalName: `KU-Grenze ${tag} GmbH`, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin",
      vatId: `DE${year}${String(seq).padStart(5, "0")}`, taxNumber: `22/${String(year).slice(1)}/00000`, defaultTaxScheme: scheme,
    },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  for (const y of [year - 1, year]) {
    for (const docType of ["INVOICE", "CREDIT_NOTE"]) {
      await dbInternal.numberRange.upsert({
        where: { orgId_docType_year: { orgId, docType, year: y } },
        create: { orgId, docType, year: y, currentValue: 0, prefix: `${tag}${docType === "INVOICE" ? "R" : "G"}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
        update: {},
      });
    }
  }
  const customerId = (await dbInternal.customer.create({ data: { orgId, name: "Kunde", addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", countryCode: "DE", type: "BUSINESS" } })).id;
  return { orgId, customerId, now };
}

interface InvOpts { netCents?: number; now?: Date; scheme?: "KLEINUNTERNEHMER" | "REGULAR"; draftOnly?: boolean }

async function invoice(c: Ctx, o: InvOpts = {}) {
  const now = o.now ?? c.now;
  const scheme = o.scheme ?? "REGULAR";
  const small = scheme === "KLEINUNTERNEHMER";
  const d = await createDraftInvoice(
    c.orgId,
    createInvoiceSchema.parse({
      customerId: c.customerId, type: "INVOICE", taxScheme: scheme, currency: "EUR", issueDate: now, deliveryDate: now,
      ...(small ? { notes: "Kleinunternehmer gemäß § 19 UStG, kein Ausweis von Umsatzsteuer" } : {}),
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: o.netCents ?? 100000, taxRate: small ? 0 : 19, taxCategory: small ? "Z" : "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now },
  );
  return o.draftOnly ? d : finalizeInvoice(d.id, { now });
}

const pay = (c: Ctx, invoiceId: string, amountCents: number, paidAt = c.now) =>
  recordPayment(invoiceId, { amountCents, paidAt, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: c.orgId, now: paidAt });

describe("kuThreshold", () => {
  it("trennt berechnet und vereinnahmt, Zahlung rechnet den Nettoanteil", async () => {
    const c = await mk();
    const inv = await invoice(c, { netCents: 100000 }); // brutto 119.000
    await pay(c, inv.id, 59500);
    const r = await kuThreshold(c.orgId, 2228);
    expect(r.current.invoicedCents).toBe(100000);
    expect(r.current.receivedCents).toBe(50000);
    expect(r.current.documentCount).toBe(1);
    expect(r.level).toBe("OK");
    expect(r.currentLimitCents).toBe(10_000_000);
    expect(r.previousYearLimitCents).toBe(2_500_000);
    expect(r.notice).toBe(KU_NOTICE);
  });

  it("Vorjahr getrennt, Ueberschreitung des Vorjahres -> EXCEEDED", async () => {
    const c = await mk();
    const prev = await invoice(c, { netCents: 2_500_001, now: PREV });
    await pay(c, prev.id, prev.grossTotalCents, PREV);
    const r = await kuThreshold(c.orgId, 2228);
    expect(r.previous.receivedCents).toBe(2_500_001);
    expect(r.current.receivedCents).toBe(0);
    expect(r.level).toBe("EXCEEDED");
    expect(r.reasons).toEqual(["PREVIOUS_OVER_25000"]);
  });

  it("Gruendungsjahr aus den Einstellungen: Grenze 25.000, Vorjahr ignoriert", async () => {
    const c = await mk("REGULAR", SET_NOW);
    await saveDocumentSettings(c.orgId, { ...(await loadDocumentSettings(c.orgId)), kuBusinessStartYear: 2099 });
    const prev = await invoice(c, { netCents: 3_000_000, now: SET_PREV });
    await pay(c, prev.id, prev.grossTotalCents, SET_PREV);
    const r = await kuThreshold(c.orgId, 2099);
    expect(r.level).toBe("OK");
    expect(r.currentLimitCents).toBe(2_500_000);
    expect(r.startYear).toBe(2099);
  });

  it("Gegenbuchung mindert den vereinnahmten Umsatz", async () => {
    const c = await mk();
    const inv = await invoice(c, { netCents: 100000 });
    const p = await pay(c, inv.id, 119000);
    expect((await kuThreshold(c.orgId, 2228)).current.receivedCents).toBe(100000);
    await reversePayment(p.recorded.id, { reason: "Falsch gebucht" }, { orgId: c.orgId, actor: "test", now: NOW });
    expect((await kuThreshold(c.orgId, 2228)).current.receivedCents).toBe(0);
  });

  it("Teilgutschrift mit Verrechnung mindert berechnet, nicht vereinnahmt", async () => {
    const c = await mk();
    const inv = await invoice(c, { netCents: 100000 });
    await createPartialCreditNote(inv.id, partialCreditSchema.parse({ lines: [{ description: "Gutschrift", quantityMilli: 1000, unitNetPriceCents: 40000, taxRate: 19 }] }), { orgId: c.orgId, now: NOW });
    const r = await kuThreshold(c.orgId, 2228);
    expect(r.current.invoicedCents).toBe(60000);
    expect(r.current.receivedCents).toBe(0);
  });

  it("Entwurf zaehlt nie", async () => {
    const c = await mk();
    await invoice(c, { netCents: 500000, draftOnly: true });
    const r = await kuThreshold(c.orgId, 2228);
    expect(r.current.invoicedCents).toBe(0);
    expect(r.current.documentCount).toBe(0);
  });

  it("Fremde Organisation beeinflusst das Ergebnis nicht", async () => {
    const a = await mk();
    const b = await mk();
    const inv = await invoice(b, { netCents: 900000 });
    await pay(b, inv.id, inv.grossTotalCents);
    const r = await kuThreshold(a.orgId, 2228);
    expect(r.current.invoicedCents).toBe(0);
    expect(r.current.receivedCents).toBe(0);
  });

  it("applies: Standardschema der Org oder Beleg mit Schema KLEINUNTERNEHMER im Jahr", async () => {
    const reg = await mk("REGULAR");
    expect((await kuThreshold(reg.orgId, 2228)).applies).toBe(false);
    await invoice(reg, { scheme: "REGULAR" });
    expect((await kuThreshold(reg.orgId, 2228)).applies).toBe(false);
    await invoice(reg, { scheme: "KLEINUNTERNEHMER", netCents: 1000 });
    expect((await kuThreshold(reg.orgId, 2228)).applies).toBe(true);
    expect((await kuThreshold(reg.orgId, 2229)).applies).toBe(false);

    const small = await mk("KLEINUNTERNEHMER");
    expect((await kuThreshold(small.orgId, 2228)).applies).toBe(true);
  });

  it("Vorpruefung: Organisation ohne Kleinunternehmerregelung laedt weder Belege noch Zahlungen", async () => {
    const reg = await mk("REGULAR");
    const inv = await invoice(reg, { netCents: 900000 });
    await pay(reg, inv.id, inv.grossTotalCents);
    const findInvoices = vi.spyOn(dbInternal.invoice, "findMany");
    const findPayments = vi.spyOn(dbInternal.payment, "findMany");
    try {
      const r = await kuThreshold(reg.orgId, 2228, { quickIfNotApplicable: true });
      expect(r).toMatchObject({ applies: false, level: "OK", reasons: [] });
      expect(findInvoices).not.toHaveBeenCalled();
      expect(findPayments).not.toHaveBeenCalled();
    } finally {
      findInvoices.mockRestore();
      findPayments.mockRestore();
    }
    const small = await mk("KLEINUNTERNEHMER");
    const full = await kuThreshold(small.orgId, 2228, { quickIfNotApplicable: true });
    expect(full).toEqual(await kuThreshold(small.orgId, 2228));
  });

  it("Fremdumsatz und Warnschwelle aus den Einstellungen", async () => {
    const c = await mk("REGULAR", SET_NOW);
    await saveDocumentSettings(c.orgId, { ...(await loadDocumentSettings(c.orgId)), kuExternalRevenue: { "2099": 1_900_000 }, kuWarnPercent: 70 });
    const inv = await invoice(c, { netCents: 100000 });
    await pay(c, inv.id, inv.grossTotalCents);
    const r = await kuThreshold(c.orgId, 2099);
    expect(r.current.externalCents).toBe(1_900_000);
    expect(r.current.totalReceivedCents).toBe(2_000_000);
    expect(r.warnPercent).toBe(70);
    expect(r.level).toBe("WARN");
  });
});
