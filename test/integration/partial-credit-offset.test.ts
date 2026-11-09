/**
 * T6 (Branch fix/editor-waehrung-storno-dnd): Teilgutschrift —
 *  - Sperre bei stornierter Rechnung, Org-Scope,
 *  - Obergrenze (Σ Gutschriften <= Rechnungsbetrag), Nummernkreis ohne Luecke,
 *  - Verrechnung mit dem offenen Rest (Payment CREDIT_NOTE), Erstattung bei bezahlter Rechnung,
 *  - BT-113 der Original-XML zaehlt nur echte Zahlungen.
 *
 * Eigenes Testjahr (2097): Invoice.number ist global @unique.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createPartialCreditNote, CreditError } from "@/domain/invoice/credit";
import { recordPayment, PaymentError } from "@/domain/invoice/payment";
import { NotFoundError } from "@/domain/errors";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { createInvoiceSchema, recordPaymentSchema } from "@/schemas";

const NOW = new Date("2097-05-01T10:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Teilgutschrift GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE111222333", taxNumber: "11/222/33333" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremde Org GmbH", addressLine1: "Teststr. 2", postalCode: "10117", city: "Berlin", vatId: "DE444555666", taxNumber: "44/555/66666" },
  });
  otherOrgId = other.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
});

// 1.000 netto @19 % = 1.190 brutto
async function invoice1190() {
  const draft = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: NOW,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    }),
    { now: NOW },
  );
  return finalizeInvoice(draft.id, { now: NOW });
}

const creditLine = (netCents: number) => ({ description: "Teilgutschrift", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate: 19, taxCategory: "S" });
const state = (id: string) => dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmountCents: true } });
const seq = (n: string | null) => Number((n ?? "").match(/(\d+)$/)?.[1]);

describe("createPartialCreditNote — Verrechnung", () => {
  it("offene Rechnung 1.190, Teilgutschrift 190 -> Rest 1.000, PARTIALLY_PAID, kein Erstattungsbedarf", async () => {
    const inv = await invoice1190();
    const res = await createPartialCreditNote(inv.id, { lines: [creditLine(16000)] }, { orgId, now: NOW }); // 160 netto = 190,40 brutto
    const gross = Math.abs(res.creditNote.grossTotalCents);
    expect(res.offsetCents).toBe(gross);
    expect(res.refundDueCents).toBe(0);
    const after = await state(inv.id);
    expect(after.status).toBe("PARTIALLY_PAID");
    expect(after.paidAmountCents).toBe(gross);
    const pay = await dbInternal.payment.findMany({ where: { invoiceId: inv.id }, select: { method: true, amountCents: true, reference: true } });
    expect(pay).toEqual([{ method: "CREDIT_NOTE", amountCents: gross, reference: res.creditNote.number }]);
    // recordPayment nimmt hoechstens den Rest an
    const rest = 119000 - gross;
    await expect(recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: rest + 1, method: "TRANSFER" }), { now: NOW })).rejects.toBeInstanceOf(PaymentError);
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: rest, method: "TRANSFER" }), { now: NOW });
    expect((await state(inv.id)).status).toBe("PAID");
  });

  it("exakt 190 brutto: Original offen 1.000", async () => {
    const inv = await invoice1190();
    // 159,66 netto -> 190,00 brutto (19 %)
    const res = await createPartialCreditNote(inv.id, { lines: [creditLine(15966)] }, { orgId, now: NOW });
    expect(Math.abs(res.creditNote.grossTotalCents)).toBe(19000);
    const a = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { grossTotalCents: true, paidAmountCents: true } });
    expect(a.grossTotalCents - a.paidAmountCents).toBe(100000);
  });

  it("bezahlte Rechnung: kein Payment, Erstattung = Gutschriftsbetrag", async () => {
    const inv = await invoice1190();
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: 119000, method: "TRANSFER" }), { now: NOW });
    const res = await createPartialCreditNote(inv.id, { lines: [creditLine(10000)] }, { orgId, now: NOW });
    expect(res.offsetCents).toBe(0);
    expect(res.refundDueCents).toBe(11900);
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id, method: "CREDIT_NOTE" } })).toBe(0);
    expect((await state(inv.id)).status).toBe("PAID");
  });

  it("teilweise bezahlt: Verrechnung nur bis zum offenen Rest, Differenz zu erstatten", async () => {
    const inv = await invoice1190();
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: 114000, method: "TRANSFER" }), { now: NOW }); // offen 50,00
    const res = await createPartialCreditNote(inv.id, { lines: [creditLine(10000)] }, { orgId, now: NOW }); // 119,00
    expect(res.offsetCents).toBe(5000);
    expect(res.refundDueCents).toBe(6900);
    expect((await state(inv.id)).status).toBe("PAID");
  });
});

describe("createPartialCreditNote — Sperren", () => {
  it("stornierte Rechnung -> CreditError", async () => {
    const inv = await invoice1190();
    await cancelInvoice(inv.id, { orgId, now: NOW });
    await expect(createPartialCreditNote(inv.id, { lines: [creditLine(1000)] }, { orgId, now: NOW })).rejects.toThrow(/storniert/);
  });

  it("fremde Organisation -> NotFoundError, nichts geschrieben", async () => {
    const inv = await invoice1190();
    await expect(createPartialCreditNote(inv.id, { lines: [creditLine(1000)] }, { orgId: otherOrgId, now: NOW })).rejects.toBeInstanceOf(NotFoundError);
    expect(await dbInternal.invoice.count({ where: { correctsInvoiceId: inv.id } })).toBe(0);
  });

  it("Obergrenze: Ueberschreitung -> CreditError, Nummernkreis ohne Luecke", async () => {
    const inv = await invoice1190();
    const first = await createPartialCreditNote(inv.id, { lines: [creditLine(50000)] }, { orgId, now: NOW }); // 595
    // 595 + 6xx > 1.190
    await expect(createPartialCreditNote(inv.id, { lines: [creditLine(60000)] }, { orgId, now: NOW })).rejects.toBeInstanceOf(CreditError);
    expect(await dbInternal.invoice.count({ where: { correctsInvoiceId: inv.id } })).toBe(1);
    const second = await createPartialCreditNote(inv.id, { lines: [creditLine(50000)] }, { orgId, now: NOW }); // Summe exakt 1.190
    expect(seq(second.creditNote.number)).toBe(seq(first.creditNote.number) + 1);
    // Rest 0 -> jede weitere Gutschrift abgewiesen
    await expect(createPartialCreditNote(inv.id, { lines: [creditLine(100)] }, { orgId, now: NOW })).rejects.toBeInstanceOf(CreditError);
  });
});

describe("E-Rechnung des Originals", () => {
  it("BT-113 zaehlt Verrechnungen mit Gutschriften nicht als bezahlt", async () => {
    const inv = await invoice1190();
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: 30000, method: "TRANSFER" }), { now: NOW });
    await createPartialCreditNote(inv.id, { lines: [creditLine(10000)] }, { orgId, now: NOW });
    const loaded = await loadEInvoiceData(inv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.data.paidCents).toBe(30000);
    const xml = buildFacturXCII(loaded!.data);
    expect(xml).toContain("<ram:TotalPrepaidAmount>300.00</ram:TotalPrepaidAmount>");
  });
});
