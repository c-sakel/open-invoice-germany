/**
 * Phase 18a, Task 2 — Teilrechnung aus Lieferschein erbt Steuerschema, Waehrung,
 * Zahlungsbedingungen, Rechnungsanschrift, Zeilenkategorie, OSS-Kategorie und
 * Positionsrabatt der Lieferschein-Quelle (Angebot/Rechnung).
 *
 * Eigenes Jahr 2161 (Invoice.number global eindeutig), Praefix B18A2-.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocument } from "@/domain/document/convert";
import { createDeliveryNote } from "@/domain/delivery-note/create";
import { createDraftInvoice } from "@/domain/invoice/create";
import type { CreateInvoiceInput } from "@/schemas";
import { createPartialInvoice, PartialInvoiceError } from "@/domain/invoice/partial";

const FIX = new Date("2161-05-01T10:00:00.000Z");

let orgId: string;
let otherOrgId: string;
let customerId: string;
let chfCustomerId: string;
let addressId: string;

function line(over: Record<string, unknown> = {}) {
  return {
    lineType: "ITEM" as const,
    description: "B18A2-Beratung",
    quantityMilli: 10_000,
    unit: "C62",
    unitNetPriceCents: 10_000,
    taxRate: 0,
    taxCategory: "AE",
    discountPermille: 100,
    discountCents: 1000,
    ...over,
  };
}

async function makeQuote(over: Record<string, unknown> = {}) {
  return createBusinessDocument(
    orgId,
    {
      kind: "ANGEBOT",
      customerId,
      taxScheme: "REVERSE_CHARGE",
      currency: "USD",
      paymentTerms: "Zahlbar in 30 Tagen",
      billingAddressId: addressId,
      lines: [line()],
      ...over,
    },
    { now: FIX },
  );
}

async function deliverFrom(quoteId: string, quantityMilli = 4000) {
  const srcLine = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId }, select: { id: true } });
  const dn = await convertDocument(
    orgId,
    { fromType: "QUOTE", fromId: quoteId, toKind: "DELIVERY_NOTE", quantities: [{ sourceLineId: srcLine.id, quantityMilli }] },
    { now: FIX },
  );
  return { dn, srcLineId: srcLine.id };
}

async function invoiceLines(invoiceId: string) {
  return dbInternal.invoiceLine.findMany({
    where: { invoiceId },
    orderBy: { position: "asc" },
    select: { taxCategory: true, ossCategory: true, discountPermille: true, discountCents: true, lineNetCents: true, quantityMilli: true },
  });
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Teilrechnung Quelle GmbH", addressLine1: "Hauptstr. 1", postalCode: "21339", city: "Lüneburg", vatId: "DE123456789", taxNumber: "33/123/45678" },
  });
  orgId = org.id;
  const other = await dbInternal.organization.create({
    data: { legalName: "Fremde Org GmbH", addressLine1: "Nebenstr. 2", postalCode: "21339", city: "Lüneburg", vatId: "DE987654321", taxNumber: "33/987/65432" },
  });
  otherOrgId = other.id;
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Kunde Quelle AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS", vatId: "FR12345678901", countryCode: "FR" },
  });
  customerId = customer.id;
  const chf = await dbInternal.customer.create({
    data: { orgId, name: "Franken AG", addressLine1: "Bahnhofstr. 1", postalCode: "8001", city: "Zuerich", type: "BUSINESS", defaultCurrency: "CHF" },
  });
  chfCustomerId = chf.id;
  const addr = await dbInternal.customerAddress.create({
    data: { orgId, customerId, type: "BILLING", addressLine1: "Rechnungsweg 5", postalCode: "20095", city: "Hamburg", countryCode: "FR" },
  });
  addressId = addr.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await ensureOrgMasterdata(dbInternal, otherOrgId);
});

describe("Teilrechnung aus Lieferschein erbt die Quelle", () => {
  it("POSITIONS: Kopf, Kategorie und Rabatt der Angebotsquelle", async () => {
    const quote = await makeQuote();
    const { dn } = await deliverFrom(quote.id);
    const dnLine = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id }, select: { id: true } });
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "POSITIONS", lineIds: [dnLine.id] }, { now: FIX });
    expect(inv.currency).toBe("USD");
    expect(inv.taxScheme).toBe("REVERSE_CHARGE");
    expect(inv.paymentTerms).toBe("Zahlbar in 30 Tagen");
    expect(inv.billingAddressId).toBe(addressId);
    const [l] = await invoiceLines(inv.id);
    expect(l).toMatchObject({ taxCategory: "AE", discountPermille: 100, discountCents: 400, lineNetCents: 35_600 });
  });

  it("QUANTITIES: Festbetragsrabatt anteilig zur Teilmenge", async () => {
    const quote = await makeQuote();
    const { dn } = await deliverFrom(quote.id);
    const dnLine = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id }, select: { id: true } });
    const inv = await createPartialInvoice(
      orgId,
      { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "QUANTITIES", quantities: [{ sourceLineId: dnLine.id, quantityMilli: 1000 }] },
      { now: FIX },
    );
    const [l] = await invoiceLines(inv.id);
    expect(l).toMatchObject({ discountCents: 100, lineNetCents: 8_900 });
  });

  it("PERCENT 100 %: Anteilsbasis nach Rabatt, weitere Teilrechnung wird abgelehnt", async () => {
    const quote = await makeQuote();
    const { dn } = await deliverFrom(quote.id);
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "PERCENT", permille: 1000 }, { now: FIX });
    expect(inv.netTotalCents).toBe(35_600);
    await expect(
      createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "PERCENT", permille: 10 }, { now: FIX }),
    ).rejects.toBeInstanceOf(PartialInvoiceError);
  });

  it("OSS-Kategorie der Angebotszeile wird uebernommen", async () => {
    const quote = await makeQuote({
      taxScheme: "REGULAR",
      currency: "EUR",
      lines: [line({ taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0, ossCategory: "ELECTRONIC_SERVICE" })],
    });
    const { dn } = await deliverFrom(quote.id);
    const dnLine = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id }, select: { id: true } });
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "POSITIONS", lineIds: [dnLine.id] }, { now: FIX });
    expect(inv.taxScheme).toBe("REGULAR");
    const [l] = await invoiceLines(inv.id);
    expect(l.ossCategory).toBe("ELECTRONIC_SERVICE");
  });

  it("geaenderter Lieferscheinpreis: Kategorie geerbt, Rabatt 0/0", async () => {
    const quote = await makeQuote();
    const { dn } = await deliverFrom(quote.id);
    const dnLine = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id }, select: { id: true } });
    await dbInternal.deliveryNoteLine.update({ where: { id: dnLine.id }, data: { unitNetPriceCents: 9_000 } });
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "POSITIONS", lineIds: [dnLine.id] }, { now: FIX });
    const [l] = await invoiceLines(inv.id);
    expect(l).toMatchObject({ taxCategory: "AE", discountPermille: 0, discountCents: 0, lineNetCents: 36_000 });
  });

  it("Quelle INVOICE (USD): Waehrung und Kategorie der Rechnungszeile", async () => {
    const src = await createDraftInvoice(
      orgId,
      {
        customerId,
        type: "INVOICE",
        taxScheme: "REVERSE_CHARGE",
        currency: "USD",
        documentDiscountPermille: 0,
        documentDiscountCents: 0,
        documentChargePermille: 0,
        documentChargeCents: 0,
        lines: [line({ discountPermille: 0, discountCents: 0 })],
      } as CreateInvoiceInput,
      { now: FIX },
    );
    const srcLine = await dbInternal.invoiceLine.findFirstOrThrow({ where: { invoiceId: src.id }, select: { id: true } });
    const dn = await convertDocument(
      orgId,
      { fromType: "INVOICE", fromId: src.id, toKind: "DELIVERY_NOTE", quantities: [{ sourceLineId: srcLine.id, quantityMilli: 4000 }] },
      { now: FIX },
    );
    const dnLine = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id }, select: { id: true } });
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "POSITIONS", lineIds: [dnLine.id] }, { now: FIX });
    expect(inv.currency).toBe("USD");
    expect(inv.taxScheme).toBe("REVERSE_CHARGE");
    const [l] = await invoiceLines(inv.id);
    expect(l.taxCategory).toBe("AE");
  });

  it("manueller Lieferschein: Kundenwaehrung, REGULAR, Kategorie S", async () => {
    const dn = await createDeliveryNote(
      orgId,
      { customerId: chfCustomerId, lines: [{ description: "B18A2-Manuell", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 5_000, taxRate: 19 }] },
      { now: FIX },
    );
    const dnLine = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id }, select: { id: true } });
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "POSITIONS", lineIds: [dnLine.id] }, { now: FIX });
    expect(inv.currency).toBe("CHF");
    expect(inv.taxScheme).toBe("REGULAR");
    expect((await invoiceLines(inv.id))[0].taxCategory).toBe("S");

    const dn2 = await createDeliveryNote(
      orgId,
      { customerId, lines: [{ description: "B18A2-Manuell2", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 5_000, taxRate: 19 }] },
      { now: FIX },
    );
    const dnLine2 = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn2.id }, select: { id: true } });
    const inv2 = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn2.id, mode: "POSITIONS", lineIds: [dnLine2.id] }, { now: FIX });
    expect(inv2.currency).toBe("EUR");
  });

  it("Org-Scope: Quelle einer fremden Org wird nicht gelesen", async () => {
    const otherCustomer = await dbInternal.customer.create({
      data: { orgId: otherOrgId, name: "Fremdkunde", addressLine1: "x 1", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
    });
    const foreign = await createBusinessDocument(
      otherOrgId,
      { kind: "ANGEBOT", customerId: otherCustomer.id, taxScheme: "REGULAR", currency: "JPY", paymentTerms: "Fremd", lines: [line({ taxRate: 19, taxCategory: "S" })] },
      { now: FIX },
    );
    const foreignLine = await dbInternal.quoteLine.findFirstOrThrow({ where: { quoteId: foreign.id }, select: { id: true } });
    const dn = await createDeliveryNote(
      orgId,
      { customerId, lines: [{ description: "B18A2-Scope", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10_000, taxRate: 19 }] },
      { now: FIX },
    );
    const dnLine = await dbInternal.deliveryNoteLine.findFirstOrThrow({ where: { deliveryNoteId: dn.id }, select: { id: true } });
    await dbInternal.$executeRaw`UPDATE "DeliveryNote" SET "sourceType" = 'QUOTE', "sourceId" = ${foreign.id} WHERE "id" = ${dn.id}`;
    await dbInternal.$executeRaw`UPDATE "DeliveryNoteLine" SET "sourceLineId" = ${foreignLine.id} WHERE "id" = ${dnLine.id}`;
    const inv = await createPartialInvoice(orgId, { sourceType: "DELIVERY_NOTE", sourceId: dn.id, mode: "POSITIONS", lineIds: [dnLine.id] }, { now: FIX });
    expect(inv.currency).toBe("EUR");
    expect(inv.taxScheme).toBe("REGULAR");
    expect(inv.paymentTerms).toBeNull();
    expect((await invoiceLines(inv.id))[0].discountPermille).toBe(0);
  });
});
