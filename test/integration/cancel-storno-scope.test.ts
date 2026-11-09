/**
 * T5 (Branch fix/editor-waehrung-storno-dnd): Storno-Domain —
 *  - Org-Scope (fremde Org -> NotFoundError),
 *  - Sperre fuer in Schlussrechnung verrechnete Abschlaege (B7),
 *  - Rest-Storno nach festgeschriebenen Teilgutschriften (B6),
 *  - Stornobeleg ohne Zahlungsbedingungen (B8),
 *  - Stornogrund in notes + ChangeLog-Diff, Erstattungshinweis (refundDueCents).
 *
 * Eigene Testjahre (2095/2096): Invoice.number ist global @unique (nicht je Org).
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice, CancelError } from "@/domain/invoice/cancel";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { recordPayment } from "@/domain/invoice/payment";
import { createBusinessDocument } from "@/domain/document/create";
import { NotFoundError } from "@/domain/errors";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { createInvoiceSchema, recordPaymentSchema } from "@/schemas";
import { getCancelPreview } from "@/domain/invoice/cancel-preview";

const NOW = new Date("2095-05-01T10:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Storno Scope GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE555666777", taxNumber: "55/666/77777" },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremde GmbH", addressLine1: "Teststr. 2", postalCode: "10117", city: "Berlin", vatId: "DE888999000", taxNumber: "88/999/00000" },
  });
  otherOrgId = other.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  customerId = customer.id;
});

type Line = { description: string; netCents: number; taxRate: 19 | 7 };
async function finalized(lines: Line[], extra: Record<string, unknown> = {}) {
  const draft = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId,
      type: "INVOICE",
      taxScheme: "REGULAR",
      currency: "EUR",
      deliveryDate: NOW,
      paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
      lines: lines.map((l) => ({ description: l.description, quantityMilli: 1000, unit: "C62", unitNetPriceCents: l.netCents, taxRate: l.taxRate, taxCategory: "S", discountPermille: 0, discountCents: 0 })),
      ...extra,
    }),
    { now: NOW },
  );
  return finalizeInvoice(draft.id, { now: NOW });
}

const creditLine = (netCents: number, taxRate: 19 | 7 = 19) => ({ description: "Teilgutschrift", quantityMilli: 1000, unit: "C62", unitNetPriceCents: netCents, taxRate, taxCategory: "S" });

describe("cancelInvoice — Org-Scope", () => {
  it("fremde Organisation -> NotFoundError, Rechnung bleibt unveraendert", async () => {
    const inv = await finalized([{ description: "A", netCents: 10000, taxRate: 19 }]);
    await expect(cancelInvoice(inv.id, { orgId: otherOrgId, now: NOW })).rejects.toBeInstanceOf(NotFoundError);
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { status: true } });
    expect(after.status).toBe("FINALIZED");
    await expect(cancelInvoice(inv.id, { orgId, now: NOW })).resolves.toBeTruthy();
  });
});

describe("cancelInvoice — Abschlag in Schlussrechnung (B7)", () => {
  it("sperrt den Abschlag, solange die Schlussrechnung aktiv ist; nach deren Storno ist er stornierbar", async () => {
    const quote = await createBusinessDocument(
      orgId,
      { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 100000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }] },
      { now: NOW },
    );
    const dp = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id, mode: "PERCENT", permille: 300 }, { now: NOW });
    const dpFin = await finalizeInvoice(dp.id, { now: NOW });
    const fin = await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id }, { now: NOW });
    const finFin = await finalizeInvoice(fin.id, { now: NOW });

    const err = await cancelInvoice(dpFin.id, { orgId: dpFin.orgId, now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CancelError);
    expect((err as Error).message).toContain(finFin.number ?? "");
    expect((err as Error).message).toContain("zuerst die Schlussrechnung stornieren");

    await cancelInvoice(finFin.id, { orgId: finFin.orgId, now: NOW });
    const res = await cancelInvoice(dpFin.id, { orgId: dpFin.orgId, now: NOW });
    expect(res.creditNote.status).toBe("FINALIZED");
  });
});

describe("cancelInvoice — Rest-Storno nach Teilgutschrift (B6)", () => {
  it("1.190,00 brutto + Teilgutschrift 119,00 -> Storno -1.071,00, Summe aller Gutschriften = -1.190,00", async () => {
    const inv = await finalized([{ description: "A", netCents: 100000, taxRate: 19 }]);
    expect(inv.grossTotalCents).toBe(119000);
    const part = await createPartialCreditNote(inv.id, { lines: [creditLine(10000)] }, { orgId: inv.orgId, now: NOW });
    expect(part.creditNote.grossTotalCents).toBe(-11900);

    const res = await cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW });
    expect(res.creditNote.grossTotalCents).toBe(-107100);
    expect(part.creditNote.grossTotalCents + res.creditNote.grossTotalCents).toBe(-inv.grossTotalCents);
    // B8: Stornobeleg ohne Zahlungsbedingungen des Originals.
    expect(res.creditNote.paymentTerms).toBeNull();
    expect(res.creditNote.notes).toContain("Teilgutschrift");

    // BR-CO-25: ohne Zahlungsbedingungen/Faelligkeit traegt die E-Rechnung BT-20 als Fallback.
    const loaded = await loadEInvoiceData(res.creditNote.id);
    if (!loaded) throw new Error("nicht gefunden");
    expect(loaded.data.paymentTermsNote).toContain("Gutschrift");
    expect(buildFacturXCII(loaded.data)).toContain("SpecifiedTradePaymentTerms");
  });

  it("ein Steuersatz, mehrere Teilgutschriften mit krummen Betraegen -> nie ueber-erstattet; Abweichung nur wenn Zielbrutto netto-ganzzahlig unerreichbar (BR-CO-17)", async () => {
    const inv = await finalized([
      { description: "A", netCents: 33333, taxRate: 19 },
      { description: "B", netCents: 7777, taxRate: 19 },
      { description: "C", netCents: 1, taxRate: 19 },
    ]);
    const p1 = await createPartialCreditNote(inv.id, { lines: [creditLine(1234)] }, { orgId: inv.orgId, now: NOW });
    const p2 = await createPartialCreditNote(inv.id, { lines: [creditLine(3333)] }, { orgId: inv.orgId, now: NOW });
    const res = await cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW });
    const sum = p1.creditNote.grossTotalCents + p2.creditNote.grossTotalCents + res.creditNote.grossTotalCents;
    // Hier ist das Zielbrutto 434,88 mit ganzzahligem Netto unerreichbar (36.544 -> 434,87; 36.545 -> 434,89):
    // der Storno nimmt den unteren Wert, die Gutschriften ueberschreiten das Original nie.
    expect(sum).toBeGreaterThanOrEqual(-inv.grossTotalCents);
    expect(sum - -inv.grossTotalCents).toBeLessThanOrEqual(1);
  });

  it("ein Steuersatz, erreichbares Zielbrutto -> Summe aller Gutschriften == Original-Brutto exakt", async () => {
    const inv = await finalized([
      { description: "A", netCents: 50000, taxRate: 19 },
      { description: "B", netCents: 50000, taxRate: 19 },
    ]);
    const p1 = await createPartialCreditNote(inv.id, { lines: [creditLine(25000)] }, { orgId: inv.orgId, now: NOW });
    const res = await cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW });
    expect(p1.creditNote.grossTotalCents + res.creditNote.grossTotalCents).toBe(-inv.grossTotalCents);
  });

  it("zwei Steuersaetze + Belegrabatt + Teilgutschrift -> Summe exakt", async () => {
    const inv = await finalized(
      [
        { description: "A", netCents: 95000, taxRate: 19 },
        { description: "B", netCents: 8333, taxRate: 7 },
      ],
      { documentDiscountPermille: 100 },
    );
    const part = await createPartialCreditNote(inv.id, { lines: [creditLine(12345, 19)] }, { orgId: inv.orgId, now: NOW });
    const res = await cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW });
    expect(part.creditNote.grossTotalCents + res.creditNote.grossTotalCents).toBe(-inv.grossTotalCents);
    const lines = await dbInternal.invoiceLine.findMany({ where: { invoiceId: res.creditNote.id } });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((l) => l.lineNetCents <= 0)).toBe(true);
  });

  it("vollstaendig gutgeschriebene Rechnung -> CancelError, kein Storno-Beleg", async () => {
    const inv = await finalized([{ description: "A", netCents: 10000, taxRate: 19 }]);
    await createPartialCreditNote(inv.id, { lines: [creditLine(10000)] }, { orgId: inv.orgId, now: NOW });
    const before = await dbInternal.invoice.count({ where: { correctsInvoiceId: inv.id } });
    await expect(cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW })).rejects.toThrow("vollständig gutgeschrieben");
    expect(await dbInternal.invoice.count({ where: { correctsInvoiceId: inv.id } })).toBe(before);
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { status: true } });
    // Voll gutgeschrieben: der Betrag wurde mit dem offenen Rest verrechnet (T6) -> PAID, nicht storniert.
    expect(after.status).toBe("PAID");
  });

  it("ohne Teilgutschrift bleibt das Storno ein 1:1-Spiegel", async () => {
    const inv = await finalized([{ description: "A", netCents: 10000, taxRate: 19 }, { description: "B", netCents: 5000, taxRate: 7 }]);
    const res = await cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW });
    expect(res.creditNote.grossTotalCents).toBe(-inv.grossTotalCents);
    const lines = await dbInternal.invoiceLine.findMany({ where: { invoiceId: res.creditNote.id } });
    expect(lines.map((l) => l.description)).toEqual(["A", "B"]);
  });
});

describe("cancelInvoice — Stornogrund und Erstattung", () => {
  it("Grund landet in notes und im ChangeLog-Diff", async () => {
    const inv = await finalized([{ description: "A", netCents: 10000, taxRate: 19 }]);
    const res = await cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW, reason: "  Falscher Empfaenger  " });
    expect(res.creditNote.notes).toContain("Grund: Falscher Empfaenger");
    const log = await dbInternal.changeLog.findFirstOrThrow({ where: { entity: "INVOICE", entityId: inv.id, action: "CANCEL" } });
    expect(JSON.parse(log.diffJson)).toMatchObject({ status: "CANCELLED", reason: "Falscher Empfaenger" });
  });

  it("refundDueCents = eingegangene Zahlungen; 0 bei unbezahlter Rechnung", async () => {
    const unpaid = await finalized([{ description: "A", netCents: 10000, taxRate: 19 }]);
    expect((await cancelInvoice(unpaid.id, { orgId: unpaid.orgId, now: NOW })).refundDueCents).toBe(0);

    const paid = await finalized([{ description: "A", netCents: 10000, taxRate: 19 }]);
    await recordPayment(paid.id, recordPaymentSchema.parse({ amountCents: 5000, method: "TRANSFER", paidAt: NOW }), { now: NOW });
    expect((await cancelInvoice(paid.id, { orgId: paid.orgId, now: NOW })).refundDueCents).toBe(5000);
  });
});


describe("getCancelPreview — Storno-Dialog", () => {
  it("Betrag, Rest nach Teilgutschrift, Zahlungen/Erstattung; fremde Org -> NotFoundError", async () => {
    const inv = await finalized([{ description: "A", netCents: 100000, taxRate: 19 }]);
    await recordPayment(inv.id, recordPaymentSchema.parse({ amountCents: 5000, method: "TRANSFER" }), { now: NOW });
    const before = await getCancelPreview(inv.id, inv.orgId);
    expect(before).toMatchObject({ number: inv.number, stornoCents: 119000, creditedCents: 0, paidCents: 5000, refundDueCents: 5000, cancellable: true, dunningLabel: null });

    await createPartialCreditNote(inv.id, { lines: [creditLine(10000)] }, { orgId: inv.orgId, now: NOW }); // 119,00, verrechnet
    const after = await getCancelPreview(inv.id, inv.orgId);
    expect(after.stornoCents).toBe(107100);
    expect(after.creditedCents).toBe(11900);
    expect(after.paidCents).toBe(5000); // Verrechnung zaehlt nicht als Zahlung
    expect(after.refundDueCents).toBe(5000);

    await expect(getCancelPreview(inv.id, otherOrgId)).rejects.toBeInstanceOf(NotFoundError);
    await cancelInvoice(inv.id, { orgId: inv.orgId, now: NOW });
    expect((await getCancelPreview(inv.id, inv.orgId)).cancellable).toBe(false);
  });
});
