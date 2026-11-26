/**
 * Weitere ChangeLog-Schreiber wiederholen bei einem Kettenkonflikt (23d Z1): der erste Versuch laeuft
 * vollstaendig durch und scheitert erst am Ende mit P2002 (orgId+prevHash) -> Rollback, zweiter Versuch
 * gelingt, genau ein Eintrag, Kette gueltig. Testjahr 2336.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { createDraftInvoice } from "@/domain/invoice/create";
import { updateDraftInvoice } from "@/domain/invoice/update";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { createDunning } from "@/domain/dunning/create";
import { createBusinessDocument } from "@/domain/document/create";
import { convertDocumentToInvoice } from "@/domain/document/convert";
import { createQueuedEmailLog, finishEmailLog, markEmailBounced, reconcileStaleQueuedEmails } from "@/domain/email/email-log";
import { convertDocument } from "@/domain/document/convert";
import { createPartialInvoice } from "@/domain/invoice/partial";
import { createDownpaymentInvoice } from "@/domain/invoice/downpayment";
import { createFinalInvoice } from "@/domain/invoice/final";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { createInvoiceSchema, type CreateDocumentInput } from "@/schemas";

const NOW = new Date("2336-05-01T10:00:00.000Z");
let orgId: string;
let customerId: string;

beforeAll(async () => {
  const org = await dbInternal.organization.create({
    data: { legalName: "Schreiberretry GmbH", addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE555666781", taxNumber: "55/666/77780" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  orgId = org.id;
  customerId = (await dbInternal.customer.create({
    data: { orgId, name: "Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  })).id;
});

afterEach(() => vi.restoreAllMocks());

const input = (extra: Record<string, unknown> = {}) =>
  createInvoiceSchema.parse({
    customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR", deliveryDate: NOW,
    paymentTerms: "Zahlbar innerhalb von 14 Tagen.",
    lines: [{ description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
    ...extra,
  });
const finalized = async (extra: Record<string, unknown> = {}) =>
  finalizeInvoice((await createDraftInvoice(orgId, input(extra), { now: NOW })).id, { now: NOW });

type TxFn = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TxHost = { $transaction: (fn: TxFn) => Promise<unknown> };

/** Die naechsten `times` Transaktionen laufen vollstaendig und scheitern erst am Ende mit einem Kettenkonflikt. */
function conflict(times = 1): { calls: () => number } {
  const host = dbInternal as unknown as TxHost;
  const original = host.$transaction.bind(host);
  let left = times;
  const spy = vi.spyOn(host, "$transaction").mockImplementation((fn: TxFn) => {
    if (left <= 0) return original(fn);
    left--;
    return original(async (tx) => {
      await fn(tx);
      throw new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "x", meta: { target: ["orgId", "prevHash"] } });
    });
  });
  return { calls: () => spy.mock.calls.length };
}

const logCount = (entityId: string, action: string) => dbInternal.changeLog.count({ where: { orgId, entityId, action } });
const chainOk = async () => expect((await verifyOrgChain(orgId, "API")).valid).toBe(true);

describe("Kettenkonflikt in weiteren Schreibern", () => {
  it("Zahlung: wiederholt, genau eine Zahlung", async () => {
    const inv = await finalized();
    const c = conflict();
    await recordPayment(inv.id, { amountCents: 5000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, actor: "test", now: NOW });
    expect(c.calls()).toBe(2);
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id } })).toBe(1);
    await chainOk();
  });

  it("Zahlungs-Gegenbuchung: wiederholt, genau eine Gegenbuchung", async () => {
    const inv = await finalized();
    await recordPayment(inv.id, { amountCents: 5000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, actor: "test", now: NOW });
    const pay = await dbInternal.payment.findFirstOrThrow({ where: { invoiceId: inv.id } });
    const c = conflict();
    await reversePayment(pay.id, { reason: "Falsch gebucht" }, { orgId, actor: "test", now: NOW });
    expect(c.calls()).toBe(2);
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id } })).toBe(2);
    await chainOk();
  });

  it("Teilgutschrift: wiederholt, genau eine Gutschrift mit lueckenloser Nummer", async () => {
    const inv = await finalized();
    const before = await dbInternal.invoice.count({ where: { orgId, type: "CREDIT_NOTE" } });
    const c = conflict();
    const res = await createPartialCreditNote(inv.id, { lines: [{ description: "Teil", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S" }] }, { orgId, actor: "test", now: NOW });
    expect(c.calls()).toBe(2);
    expect(res.creditNote.number).toBeTruthy();
    expect(await dbInternal.invoice.count({ where: { orgId, type: "CREDIT_NOTE" } })).toBe(before + 1);
    await chainOk();
  });

  it("Entwurf bearbeiten: wiederholt, genau ein ChangeLog-Eintrag", async () => {
    const draft = await createDraftInvoice(orgId, input(), { now: NOW });
    const c = conflict();
    await updateDraftInvoice(orgId, draft.id, { subject: "Geaendert" }, "tester");
    expect(c.calls()).toBe(2);
    expect(await logCount(draft.id, "UPDATE")).toBe(1);
    await chainOk();
  });

  it("Mahnung: wiederholt, genau eine Mahnung", async () => {
    const inv = await finalized({ dueDate: new Date("2336-03-01") });
    const c = conflict();
    await createDunning(inv.id, { now: NOW, orgId });
    expect(c.calls()).toBe(2);
    expect(await dbInternal.dunning.count({ where: { invoiceId: inv.id } })).toBe(1);
    expect(await logCount(inv.id, "DUNNING_CREATE")).toBe(1);
    await chainOk();
  });

  it("Angebot -> Rechnung: wiederholt, genau eine Rechnung, Verknuepfung gesetzt", async () => {
    const quote = await createBusinessDocument(
      orgId,
      { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }] } as CreateDocumentInput,
      { now: NOW },
    );
    const c = conflict();
    const inv = await convertDocumentToInvoice(orgId, quote.id, { now: NOW });
    expect(c.calls()).toBe(2);
    const q = await dbInternal.quote.findUniqueOrThrow({ where: { id: quote.id }, select: { convertedToInvoiceId: true } });
    expect(q.convertedToInvoiceId).toBe(inv.id);
    expect(await dbInternal.invoice.count({ where: { orgId, id: inv.id } })).toBe(1);
    await chainOk();
  });

  it("E-Mail-Protokoll: wiederholt, genau ein ChangeLog-Eintrag", async () => {
    const inv = await finalized();
    const log = await createQueuedEmailLog({
      orgId, docType: "INVOICE", docId: inv.id, fromEmail: "a@example.com", to: ["k@example.com"], cc: [], bcc: [],
      subject: "Rechnung", bodySnapshot: "Text", sentByUserId: "test",
    });
    const c = conflict();
    await finishEmailLog({
      orgId, logId: log.id, status: "SENT", providerId: "p1", actor: "test", docType: "INVOICE", docId: inv.id,
      to: ["k@example.com"], cc: [], bcc: [], subject: "Rechnung", at: NOW,
    });
    expect(c.calls()).toBe(2);
    expect(await logCount(log.id, "SENT")).toBe(1);
    await chainOk();
  });

  const quoteDoc = () =>
    createBusinessDocument(
      orgId,
      { kind: "ANGEBOT", customerId, taxScheme: "REGULAR", currency: "EUR", lines: [{ lineType: "ITEM", description: "Beratung", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }] } as CreateDocumentInput,
      { now: NOW },
    );
  const queuedMail = async (docId: string) =>
    createQueuedEmailLog({
      orgId, docType: "INVOICE", docId, fromEmail: "a@example.com", to: ["k@example.com"], cc: [], bcc: [],
      subject: "Rechnung", bodySnapshot: "Text", sentByUserId: "test",
    });
  const mailStatus = async (id: string) => (await dbInternal.emailLog.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

  it("E-Mail als unzustellbar markieren: wiederholt, genau ein BOUNCED-Eintrag", async () => {
    const inv = await finalized();
    const log = await queuedMail(inv.id);
    await finishEmailLog({
      orgId, logId: log.id, status: "SENT", providerId: "p1", actor: "test", docType: "INVOICE", docId: inv.id,
      to: ["k@example.com"], cc: [], bcc: [], subject: "Rechnung", at: NOW,
    });
    const c = conflict();
    expect(await markEmailBounced(orgId, log.id, "test", NOW)).toBe(true);
    expect(c.calls()).toBe(2);
    expect(await logCount(log.id, "BOUNCED")).toBe(1);
    expect(await mailStatus(log.id)).toBe("BOUNCED");
    await chainOk();
  });

  it("Abgleich haengender QUEUED-Mails: wiederholt, genau ein FAILED-Eintrag", async () => {
    const inv = await finalized();
    const log = await queuedMail(inv.id);
    await dbInternal.emailLog.update({ where: { id: log.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });
    const c = conflict();
    expect(await reconcileStaleQueuedEmails(new Date())).toBeGreaterThanOrEqual(1);
    expect(c.calls()).toBeGreaterThanOrEqual(2);
    expect(await logCount(log.id, "FAILED")).toBe(1);
    expect(await mailStatus(log.id)).toBe("FAILED");
    await chainOk();
  });

  it("Angebot -> Auftragsbestaetigung: wiederholt, genau eine Bestaetigung", async () => {
    const quote = await quoteDoc();
    const before = await dbInternal.quote.count({ where: { orgId, kind: "AUFTRAGSBESTAETIGUNG" } });
    const c = conflict();
    const res = await convertDocument(orgId, { fromType: "QUOTE", fromId: quote.id, toKind: "AUFTRAGSBESTAETIGUNG" }, { now: NOW });
    expect(c.calls()).toBe(2);
    expect(res.type).toBe("QUOTE");
    expect(await dbInternal.quote.count({ where: { orgId, kind: "AUFTRAGSBESTAETIGUNG" } })).toBe(before + 1);
    await chainOk();
  });

  it("Angebot -> Lieferschein: wiederholt, genau ein Lieferschein", async () => {
    const quote = await quoteDoc();
    const before = await dbInternal.deliveryNote.count({ where: { orgId } });
    const c = conflict();
    const res = await convertDocument(orgId, { fromType: "QUOTE", fromId: quote.id, toKind: "DELIVERY_NOTE" }, { now: NOW });
    expect(c.calls()).toBe(2);
    expect(res.type).toBe("DELIVERY_NOTE");
    expect(await dbInternal.deliveryNote.count({ where: { orgId } })).toBe(before + 1);
    await chainOk();
  });

  it("Teilrechnung: wiederholt, genau eine Rechnung", async () => {
    const quote = await quoteDoc();
    const before = await dbInternal.invoice.count({ where: { orgId, type: "PARTIAL" } });
    const c = conflict();
    const inv = await createPartialInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id, mode: "PERCENT", permille: 500 }, { now: NOW });
    expect(c.calls()).toBe(2);
    expect(inv.id).toBeTruthy();
    expect(await dbInternal.invoice.count({ where: { orgId, type: "PARTIAL" } })).toBe(before + 1);
    await chainOk();
  });

  it("Abschlags- und Schlussrechnung: je wiederholt, je genau eine Rechnung", async () => {
    const quote = await quoteDoc();
    const downBefore = await dbInternal.invoice.count({ where: { orgId, type: "DOWNPAYMENT" } });
    const c1 = conflict();
    const down = await createDownpaymentInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id, mode: "PERCENT", permille: 300 }, { now: NOW });
    expect(c1.calls()).toBe(2);
    expect(await dbInternal.invoice.count({ where: { orgId, type: "DOWNPAYMENT" } })).toBe(downBefore + 1);
    vi.restoreAllMocks();

    await finalizeInvoice(down.id, { now: NOW });
    const finalBefore = await dbInternal.invoice.count({ where: { orgId, type: "FINAL" } });
    const c2 = conflict();
    await createFinalInvoice(orgId, { sourceType: "QUOTE", sourceId: quote.id }, { now: NOW });
    expect(c2.calls()).toBe(2);
    expect(await dbInternal.invoice.count({ where: { orgId, type: "FINAL" } })).toBe(finalBefore + 1);
    await chainOk();
  });

  it("Erschoepfung: dauerhafter Konflikt wirft nach 8 Versuchen, nichts verbucht", async () => {
    const inv = await finalized();
    const c = conflict(100);
    await expect(
      recordPayment(inv.id, { amountCents: 5000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId, actor: "test", now: NOW }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(c.calls()).toBe(8);
    vi.restoreAllMocks();
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id } })).toBe(0);
  });
});
