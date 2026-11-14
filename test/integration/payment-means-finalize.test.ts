/**
 * Phase 18e Task 4: Lastschrift-Snapshot beim Festschreiben, Kartenfelder am Entwurf,
 * Hinweise bei unvollstaendigen Angaben. Testjahr 2181, eigene Organisation.
 */
import { beforeAll, describe, it, expect } from "vitest";
import { dbInternal, prisma } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { collectFinalizeWarnings, parseWarningCodes } from "@/domain/invoice/finalize-warnings";
import { duplicateDocument } from "@/domain/document/duplicate";
import { createRecurring } from "@/domain/recurring/create";
import { emitRecurringInvoice as emitRecurringNow } from "../helpers/emit-recurring";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { GobdImmutabilityError } from "@/lib/db";
import { loadEInvoiceData } from "@/lib/einvoice/load";
import { buildXRechnungUBL } from "@/lib/einvoice/xrechnung";
import { buildFacturXCII } from "@/lib/einvoice/cii";
import { createInvoiceSchema, createRecurringSchema } from "@/schemas";

const NOW = new Date("2181-03-02T10:00:00.000Z");
const CREDITOR = "DE98ZZZ09999999999";
const IBAN = "DE02120300000000202051";

let orgId: string;
let sepaId: string;
let cardId: string;
let transferId: string;
let customerId: string;
let customerNoMandateId: string;

async function methodId(code: string): Promise<string> {
  return (await dbInternal.paymentMethod.findFirstOrThrow({ where: { orgId, code }, select: { id: true } })).id;
}

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: {
      legalName: "Zahlmittel GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin",
      vatId: "DE218100001", taxNumber: "21/810/00001", iban: IBAN, bic: "BYLADEM1001", sepaCreditorId: CREDITOR,
    },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  sepaId = await methodId("SEPA");
  cardId = await methodId("CREDIT_CARD");
  transferId = await methodId("TRANSFER");
  const base = { orgId, addressLine1: "Weg 1", postalCode: "10115", city: "Berlin", type: "BUSINESS" as const, email: "kunde@example.org" };
  customerId = (
    await dbInternal.customer.create({
      data: {
        ...base, name: "Mandat Kunde",
        sepaMandateReference: "MANDAT-2181-001", sepaMandateSignedAt: new Date("2180-01-15T00:00:00.000Z"),
        sepaDebitIban: IBAN, sepaDebitAccountName: "Erika Beispiel",
        defaultPaymentMethodId: sepaId,
      },
    })
  ).id;
  customerNoMandateId = (await dbInternal.customer.create({ data: { ...base, name: "Ohne Mandat" } })).id;
});

const lines = [{ description: "Beratung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }];

function draft(over: Record<string, unknown> = {}) {
  return createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId, type: "INVOICE", taxScheme: "REGULAR", issueDate: NOW, deliveryDate: NOW, paymentMethodId: sepaId, lines, ...over,
    }),
    { now: NOW },
  );
}

async function xml(invoiceId: string): Promise<{ ubl: string; cii: string }> {
  const loaded = await loadEInvoiceData(invoiceId);
  if (!loaded) throw new Error("nicht ladbar");
  return { ubl: buildXRechnungUBL(loaded.data), cii: buildFacturXCII(loaded.data) };
}

describe("Lastschrift: Snapshot beim Festschreiben", () => {
  it("vollstaendig: kein Hinweis, Snapshot gesetzt, XML bleibt nach Stammdatenaenderung byte-gleich", async () => {
    const d = await draft();
    expect(await collectFinalizeWarnings(orgId, d.id)).toEqual([]);
    const fin = await finalizeInvoice(d.id, { now: NOW });
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: fin.id }, select: { directDebitSnapshotJson: true } });
    expect(JSON.parse(row.directDebitSnapshotJson ?? "null")).toEqual({
      creditorId: CREDITOR, mandateReference: "MANDAT-2181-001", mandateSignedAt: "2180-01-15",
      debtorIban: IBAN, debtorAccountName: "Erika Beispiel",
    });
    const before = await xml(fin.id);
    expect(before.ubl).toContain("PaymentMandate");

    await dbInternal.customer.update({
      where: { id: customerId },
      data: { sepaDebitIban: "DE89370400440532013000", sepaMandateReference: "MANDAT-2181-999" },
    });
    await dbInternal.organization.update({ where: { id: orgId }, data: { sepaCreditorId: "DE00ZZZ00000000000" } });
    const after = await xml(fin.id);
    expect(after.ubl).toBe(before.ubl);
    expect(after.cii).toBe(before.cii);

    await dbInternal.customer.update({
      where: { id: customerId },
      data: { sepaDebitIban: IBAN, sepaMandateReference: "MANDAT-2181-001" },
    });
    await dbInternal.organization.update({ where: { id: orgId }, data: { sepaCreditorId: CREDITOR } });
  });

  it("Kunde ohne Mandat: Hinweis, Festschreiben gelingt, Snapshot null, UBL Code 1", async () => {
    const d = await draft({ customerId: customerNoMandateId });
    const warnings = await collectFinalizeWarnings(orgId, d.id);
    expect(warnings.map((w) => w.code)).toEqual(["lastschrift-unvollstaendig"]);
    const fin = await finalizeInvoice(d.id, { now: NOW });
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: fin.id }, select: { directDebitSnapshotJson: true } });
    expect(row.directDebitSnapshotJson).toBeNull();
    const { ubl } = await xml(fin.id);
    expect(ubl).toContain("<cbc:PaymentMeansCode>1</cbc:PaymentMeansCode>");
    expect(ubl).not.toContain("PaymentMandate");
  });

  it("Org ohne Glaeubiger-ID: Hinweis, Snapshot null", async () => {
    await dbInternal.organization.update({ where: { id: orgId }, data: { sepaCreditorId: null } });
    try {
      const d = await draft();
      expect((await collectFinalizeWarnings(orgId, d.id)).map((w) => w.code)).toEqual(["lastschrift-unvollstaendig"]);
      const fin = await finalizeInvoice(d.id, { now: NOW });
      const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: fin.id }, select: { directDebitSnapshotJson: true } });
      expect(row.directDebitSnapshotJson).toBeNull();
    } finally {
      await dbInternal.organization.update({ where: { id: orgId }, data: { sepaCreditorId: CREDITOR } });
    }
  });

  it("Storno: Gutschrift ohne Snapshot und ohne Mandatsgruppe", async () => {
    const d = await draft();
    const fin = await finalizeInvoice(d.id, { now: NOW });
    const { creditNote: credit } = await cancelInvoice(fin.id, { orgId, now: NOW });
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: credit.id }, select: { directDebitSnapshotJson: true } });
    expect(row.directDebitSnapshotJson).toBeNull();
    const { ubl, cii } = await xml(credit.id);
    expect(ubl).not.toContain("PaymentMandate");
    expect(cii).not.toContain("DirectDebitMandateID");
  });

  it("Abo mit autoFinalize: erzeugte Rechnung traegt den Snapshot", async () => {
    const rec = await createRecurring(
      orgId,
      createRecurringSchema.parse({ customerId, title: "Abo", startDate: NOW, autoFinalize: true, lines }),
    );
    const emitted = await emitRecurringNow(rec.id, { now: NOW });
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: emitted.invoiceId }, select: { directDebitSnapshotJson: true } });
    expect(row.directDebitSnapshotJson).not.toBeNull();
  });
});

describe("Karte: Kartenfelder am Entwurf", () => {
  const cardInput = { paymentMethodId: "", cardPanTruncated: "1234", cardNetwork: "VISA", cardHolderName: "Erika Beispiel" };

  it("vollstaendig: Felder bleiben nach dem Festschreiben, UBL CardAccount", async () => {
    const d = await draft({ ...cardInput, paymentMethodId: cardId });
    expect(d.cardPanTruncated).toBe("1234");
    expect(await collectFinalizeWarnings(orgId, d.id)).toEqual([]);
    const fin = await finalizeInvoice(d.id, { now: NOW });
    expect(fin.cardPanTruncated).toBe("1234");
    expect(fin.cardNetwork).toBe("VISA");
    expect((await xml(fin.id)).ubl).toContain("CardAccount");
    await expect(prisma.invoice.update({ where: { id: fin.id }, data: { cardNetwork: "MASTERCARD" } })).rejects.toBeInstanceOf(GobdImmutabilityError);
  });

  it("ohne Netz: Hinweis karte-unvollstaendig, UBL Code 1", async () => {
    const d = await draft({ paymentMethodId: cardId, cardPanTruncated: "1234" });
    expect((await collectFinalizeWarnings(orgId, d.id)).map((w) => w.code)).toEqual(["karte-unvollstaendig"]);
    const fin = await finalizeInvoice(d.id, { now: NOW });
    expect((await xml(fin.id)).ubl).toContain("<cbc:PaymentMeansCode>1</cbc:PaymentMeansCode>");
  });

  it("Nicht-Kartenmethode: Kartenfelder werden beim Anlegen verworfen", async () => {
    const d = await draft({ ...cardInput, paymentMethodId: transferId });
    expect(d.cardPanTruncated).toBeNull();
    expect(d.cardNetwork).toBeNull();
    expect(d.cardHolderName).toBeNull();
  });

  it("Update: Methodenwechsel 54 -> 58 leert, nur Kartenfelder bei Kartenmethode werden gespeichert", async () => {
    const d = await draft({ ...cardInput, paymentMethodId: cardId });
    const onlyCard = await updateDraftInvoice(orgId, d.id, { cardNetwork: "MASTERCARD" }, "test");
    expect(onlyCard.cardNetwork).toBe("MASTERCARD");
    expect(onlyCard.cardPanTruncated).toBe("1234");
    const switched = await updateDraftInvoice(orgId, d.id, { paymentMethodId: transferId }, "test");
    expect(switched.cardPanTruncated).toBeNull();
    expect(switched.cardNetwork).toBeNull();
    expect(switched.cardHolderName).toBeNull();
    const ignored = await updateDraftInvoice(orgId, d.id, { cardNetwork: "VISA" }, "test");
    expect(ignored.cardNetwork).toBeNull();
  });

  it("Duplikat einer Kartenrechnung traegt keine Kartenfelder", async () => {
    const d = await draft({ ...cardInput, paymentMethodId: cardId });
    const fin = await finalizeInvoice(d.id, { now: NOW });
    const copy = await duplicateDocument(orgId, "INVOICE", fin.id, "test", NOW);
    const row = await dbInternal.invoice.findUniqueOrThrow({
      where: { id: copy.id },
      select: { cardPanTruncated: true, cardNetwork: true, cardHolderName: true },
    });
    expect(row).toEqual({ cardPanTruncated: null, cardNetwork: null, cardHolderName: null });
  });
});

describe("Hinweiscodes und Kette", () => {
  it("parseWarningCodes behaelt nur bekannte Codes", () => {
    expect(parseWarningCodes("lastschrift-unvollstaendig,foo")).toEqual(["lastschrift-unvollstaendig"]);
    expect(parseWarningCodes("karte-unvollstaendig")).toEqual(["karte-unvollstaendig"]);
  });

  it("Hash-Kette der Organisation bleibt gueltig", async () => {
    expect((await verifyOrgChain(orgId, "UI")).valid).toBe(true);
  });
});
