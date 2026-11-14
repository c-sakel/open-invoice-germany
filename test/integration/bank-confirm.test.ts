/**
 * Bankabgleich: Zuordnung bestaetigen, aufteilen, ignorieren, Sammelbestaetigung. Testjahr 2202.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { BankAllocationError, BankConflictError } from "@/domain/bank/errors";
import { confirmBankMatch, confirmUnambiguous, ignoreBankTransaction, reopenBankTransaction } from "@/domain/bank/confirm";
import { bankIbanHash } from "@/domain/bank/suggest";
import { PaymentError, recordPayment } from "@/domain/invoice/payment";
import { createDraftInvoice } from "@/domain/invoice/create";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { upsertManualRate } from "@/domain/fx/store";
import { exchangeRateUpsertSchema } from "@/schemas/fx";
import type { CreateInvoiceInput } from "@/schemas";
import { NotFoundError } from "@/domain/errors";
import { createWebhookEndpoint } from "@/domain/webhook/endpoints";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { mkBankOrg, mkBankTx, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2202-03-01T10:00:00.000Z");
const BOOK = new Date("2202-03-05T00:00:00.000Z");
const NOW = new Date("2202-03-06T10:00:00.000Z");
const opts = { actor: "tester", createdBy: "user" as const, now: NOW };
const GROSS = 11900;

let org: BankTestOrg;
let other: BankTestOrg;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  org = await mkBankOrg("Bank Confirm GmbH", ISSUE);
  other = await mkBankOrg("Bank Fremd GmbH", ISSUE);
});

const view = (id: string) =>
  dbInternal.bankTransaction.findUniqueOrThrow({ where: { id }, select: { status: true, allocatedCents: true, ignoredReason: true } });
const payCount = (invoiceId: string) => dbInternal.payment.count({ where: { invoiceId } });

describe("Bankabgleich: bestaetigen", () => {
  it("volle Zuordnung: Rechnung PAID, Zahlung mit Herkunft BANK, ChangeLog, Webhooks, Umsatz MATCHED, Gegenkonto-Hinweis", async () => {
    const ep = await createWebhookEndpoint(org.orgId, { url: "https://93.184.216.40/hook", events: ["payment.recorded", "invoice.paid"] }, { now: NOW });
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, remittance: `Rechnung ${inv.number}` });
    const r = await confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts);
    expect(r.transaction.status).toBe("MATCHED");
    expect(r.transaction.allocatedCents).toBe(GROSS);
    const pay = await dbInternal.payment.findUniqueOrThrow({ where: { id: r.payments[0]!.paymentId } });
    expect(pay.provider).toBe("BANK");
    expect(pay.providerPaymentId).toBe(`${txId}:1`);
    expect(pay.paidAt.toISOString()).toBe(BOOK.toISOString());
    expect(pay.method).toBe("TRANSFER");
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    expect(await dbInternal.changeLog.count({ where: { orgId: org.orgId, entityId: inv.id, action: "PAYMENT" } })).toBe(1);
    const events = (await dbInternal.webhookDelivery.findMany({ where: { endpointId: ep.id }, select: { event: true } })).map((d) => d.event);
    expect(events).toContain("payment.recorded");
    expect(events).toContain("invoice.paid");
    const m = await dbInternal.bankMatch.findMany({ where: { transactionId: txId } });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "PAYMENT", orgId: org.orgId, paymentId: pay.id, amountCents: GROSS });
    expect((await verifyOrgChain(org.orgId, "UI")).valid).toBe(true);

    const hint = await dbInternal.bankCounterpartyHint.findFirstOrThrow({ where: { orgId: org.orgId } });
    expect(hint.ibanHash).toBe(bankIbanHash("GB82WEST12345698765432"));
    expect(hint.ibanHash).not.toContain("GB82");
    expect(hint.customerId).toBe(org.customerId);
    expect(hint.useCount).toBe(1);
    const inv2 = await mkInvoice(org, ISSUE);
    const tx2 = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK });
    await confirmBankMatch(org.orgId, tx2, { allocations: [{ invoiceId: inv2.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts);
    expect((await dbInternal.bankCounterpartyHint.findUniqueOrThrow({ where: { id: hint.id } })).useCount).toBe(2);
  });

  it("Aufteilung auf zwei Rechnungen: zwei Zahlungen :1 und :2", async () => {
    const a = await mkInvoice(org, ISSUE);
    const b = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: 2 * GROSS, bookingDate: BOOK });
    const r = await confirmBankMatch(
      org.orgId, txId,
      { allocations: [{ invoiceId: a.id, amountCents: GROSS }, { invoiceId: b.id, amountCents: GROSS }], expectedAllocatedCents: 0 },
      opts,
    );
    const pays = await dbInternal.payment.findMany({ where: { id: { in: r.payments.map((p) => p.paymentId) } }, select: { providerPaymentId: true, amountCents: true } });
    expect(pays.map((p) => p.providerPaymentId).sort()).toEqual([`${txId}:1`, `${txId}:2`]);
    expect(pays.reduce((s, p) => s + p.amountCents, 0)).toBe(2 * GROSS);
    expect(r.transaction.status).toBe("MATCHED");
  });

  it("Ueberzahlung wird nie als Zahlung gebucht; Teilzuordnung PARTIAL; Rest ignorieren mit Grund", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS + 2000, bookingDate: BOOK });
    await expect(
      confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: inv.id, amountCents: GROSS + 2000 }], expectedAllocatedCents: 0 }, opts),
    ).rejects.toBeInstanceOf(PaymentError);
    expect(await payCount(inv.id)).toBe(0);
    const r = await confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts);
    expect(r.transaction.status).toBe("PARTIAL");
    expect(r.transaction.amountCents - r.transaction.allocatedCents).toBe(2000);
    await expect(ignoreBankTransaction(org.orgId, txId, { reason: "ab" }, opts)).rejects.toThrow();
    const ig = await ignoreBankTransaction(org.orgId, txId, { reason: "Ueberzahlung, ausserhalb klaeren" }, opts);
    expect(ig.status).toBe("IGNORED");
    expect(ig.allocatedCents).toBe(GROSS);
    await expect(reopenBankTransaction(org.orgId, txId, opts)).rejects.toBeInstanceOf(BankAllocationError);
  });

  it("Summe groesser als Umsatzrest: BankAllocationError, Rollback, Kette gueltig", async () => {
    const a = await mkInvoice(org, ISSUE);
    const b = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS + 100, bookingDate: BOOK });
    await expect(
      confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: a.id, amountCents: GROSS }, { invoiceId: b.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts),
    ).rejects.toBeInstanceOf(BankAllocationError);
    expect(await payCount(a.id)).toBe(0);
    expect(await payCount(b.id)).toBe(0);
    expect((await view(txId)).status).toBe("OPEN");
    expect((await verifyOrgChain(org.orgId, "UI")).valid).toBe(true);
  });

  it("Skonto in Frist mit applySkonto: zwei Zahlungen, PAID, allocatedCents = Ueberweisungsbetrag", async () => {
    const inv = await mkInvoice(org, ISSUE, { skonto: true });
    const transfer = GROSS - 238;
    const txId = await mkBankTx(org, { amountCents: transfer, bookingDate: new Date("2202-03-08T00:00:00.000Z") });
    const r = await confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: inv.id, amountCents: transfer, applySkonto: true }], expectedAllocatedCents: 0 }, opts);
    expect(r.payments[0]!.skontoPaymentId).toBeTruthy();
    expect(await payCount(inv.id)).toBe(2);
    expect((await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    expect(r.transaction.allocatedCents).toBe(transfer);
    expect(r.transaction.status).toBe("MATCHED");
    const kinds = (await dbInternal.bankMatch.findMany({ where: { transactionId: txId } })).map((m) => m.kind).sort();
    expect(kinds).toEqual(["PAYMENT", "SKONTO"]);
  });

  it("veralteter expectedAllocatedCents und Wiederholung nach Erfolg: 409, nichts gebucht", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK });
    await expect(
      confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 500 }, opts),
    ).rejects.toBeInstanceOf(BankConflictError);
    expect(await payCount(inv.id)).toBe(0);
    const input = { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 };
    await confirmBankMatch(org.orgId, txId, input, opts);
    await expect(confirmBankMatch(org.orgId, txId, input, opts)).rejects.toBeInstanceOf(BankConflictError);
    expect(await payCount(inv.id)).toBe(1);
  });

  it("fremde Organisation: Umsatz oder Rechnung gleichlautend NotFound; Waehrung muss passen", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const foreignTx = await mkBankTx(other, { amountCents: GROSS, bookingDate: BOOK });
    const ownTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK });
    const input = { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 };
    await expect(confirmBankMatch(org.orgId, foreignTx, input, opts)).rejects.toBeInstanceOf(NotFoundError);
    await expect(confirmBankMatch(org.orgId, "ckunknownunknownunknown00", input, opts)).rejects.toThrow("Bankumsatz nicht gefunden.");
    const foreignInv = await mkInvoice(other, ISSUE);
    await expect(
      confirmBankMatch(org.orgId, ownTx, { allocations: [{ invoiceId: foreignInv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts),
    ).rejects.toThrow("Rechnung nicht gefunden.");
    expect(await payCount(foreignInv.id)).toBe(0);
    await upsertManualRate(exchangeRateUpsertSchema.parse({ source: "MONTHLY", currency: "USD", rateDate: "2202-03-01", rate: "1,2" }), "test", org.orgId);
    const usd = await mkInvoice(org, ISSUE, { currency: "USD" });
    await expect(
      confirmBankMatch(org.orgId, ownTx, { allocations: [{ invoiceId: usd.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts),
    ).rejects.toBeInstanceOf(BankAllocationError);
    expect(await payCount(usd.id)).toBe(0);
  });

  it("Entwurf oder stornierte Rechnung: PaymentError, Rollback", async () => {
    const cancelled = await mkInvoice(org, ISSUE);
    await cancelInvoice(cancelled.id, { now: ISSUE, actor: "tester", orgId: org.orgId, reason: "Testfall" });
    const draft = await createDraftInvoice(
      org.orgId,
      {
        customerId: org.customerId, type: "INVOICE", taxScheme: "REGULAR", currency: "EUR",
        documentDiscountPermille: 0, documentDiscountCents: 0, documentChargePermille: 0, documentChargeCents: 0,
        issueDate: ISSUE, deliveryDate: ISSUE,
        lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      } as CreateInvoiceInput,
      { now: ISSUE },
    );
    for (const id of [cancelled.id, draft.id]) {
      const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK });
      await expect(
        confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts),
      ).rejects.toBeInstanceOf(PaymentError);
      expect((await view(txId)).status).toBe("OPEN");
      expect(await dbInternal.bankMatch.count({ where: { transactionId: txId } })).toBe(0);
    }
  });

  it("Rueckbuchungs-Umsatz (RETURN) kann nicht als Zahlung gebucht werden", async () => {
    const inv = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, status: "RETURN", remittance: inv.number });
    await expect(
      confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts),
    ).rejects.toBeInstanceOf(BankAllocationError);
    expect(await payCount(inv.id)).toBe(0);
    expect((await view(txId)).status).toBe("RETURN");
  });
});

describe("Bankabgleich: Sammelbestaetigung", () => {
  it("3 SICHER + 1 MOEGLICH: confirmed 3, MOEGLICH unberuehrt; zwischenzeitlich bezahlte Rechnung -> skipped", async () => {
    const o = await mkBankOrg("Bank Sammel GmbH", ISSUE);
    const sure: Array<{ inv: Awaited<ReturnType<typeof mkInvoice>>; txId: string }> = [];
    for (let i = 0; i < 4; i++) {
      const inv = await mkInvoice(o, ISSUE, { netCents: 10000 + i * 100 });
      const txId = await mkBankTx(o, { amountCents: inv.grossCents, bookingDate: BOOK, remittance: `Zahlung ${inv.number}` });
      sure.push({ inv, txId });
    }
    // MOEGLICH: keine Nummer im Text, nur Betrag + Name
    const poss = await mkInvoice(o, ISSUE, { netCents: 55555 });
    const possTx = await mkBankTx(o, { amountCents: poss.grossCents, bookingDate: BOOK, remittance: "ohne Bezug" });
    // eine der vier wird zwischenzeitlich anderweitig bezahlt
    await recordPayment(sure[3]!.inv.id, { amountCents: sure[3]!.inv.grossCents, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: o.orgId, now: NOW });

    const r = await confirmUnambiguous(o.orgId, {}, opts);
    expect(r.confirmed).toBe(3);
    expect(r).toMatchObject({ truncated: false, remaining: 0 });
    expect((await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: possTx } })).status).toBe("OPEN");
    expect(await dbInternal.bankMatch.count({ where: { transactionId: possTx } })).toBe(0);
    for (const s of sure.slice(0, 3)) expect((await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: s.txId } })).status).toBe("MATCHED");
    expect((await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: sure[3]!.txId } })).status).toBe("OPEN");
    expect((await verifyOrgChain(o.orgId, "UI")).valid).toBe(true);
  });

  it("zwischenzeitlich bezahlte Rechnung unter explizitem Id: skipped mit Grund, Rest gebucht; RETURN wird nie aufgenommen", async () => {
    const o = await mkBankOrg("Bank Sammel 2 GmbH", ISSUE);
    const a = await mkInvoice(o, ISSUE, { netCents: 20000 });
    const b = await mkInvoice(o, ISSUE, { netCents: 20100 });
    const ta = await mkBankTx(o, { amountCents: a.grossCents, bookingDate: BOOK, remittance: a.number });
    const tb = await mkBankTx(o, { amountCents: b.grossCents, bookingDate: BOOK, remittance: b.number });
    const ret = await mkBankTx(o, { amountCents: b.grossCents, bookingDate: BOOK, remittance: b.number, status: "RETURN" });
    const r = await confirmUnambiguous(o.orgId, { transactionIds: [ta, tb, ret] }, opts);
    expect(r.confirmed).toBe(2);
    expect(r.skipped.map((s) => s.transactionId)).toEqual([ret]);
    expect((await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: ret } })).status).toBe("RETURN");
    expect(await dbInternal.bankMatch.count({ where: { transactionId: ret } })).toBe(0);
  });
});

describe("Bankabgleich: Sammelbestaetigung mit Skonto", () => {
  it("sicherer Vorschlag mit Skonto-Abzug wird nicht gesammelt gebucht", async () => {
    const o = await mkBankOrg("Bank Sammel Skonto GmbH", ISSUE);
    const inv = await mkInvoice(o, ISSUE, { netCents: 30000, skonto: true });
    const skontoCents = Math.round(inv.grossCents * 0.98);
    const txId = await mkBankTx(o, { amountCents: skontoCents, bookingDate: BOOK, remittance: inv.number });
    const r = await confirmUnambiguous(o.orgId, { transactionIds: [txId] }, opts);
    expect(r.confirmed).toBe(0);
    expect(r.skipped.map((s) => s.transactionId)).toEqual([txId]);
    expect((await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: txId } })).status).toBe("OPEN");
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id } })).toBe(0);
  });
});

describe("Bankabgleich: ignorieren und wieder oeffnen", () => {
  it("Grund Pflicht (3..300); reopen nur aus IGNORED mit allocatedCents 0", async () => {
    const txId = await mkBankTx(org, { amountCents: 1000, bookingDate: BOOK });
    await expect(ignoreBankTransaction(org.orgId, txId, { reason: "" }, opts)).rejects.toThrow();
    await expect(ignoreBankTransaction(org.orgId, txId, { reason: "x".repeat(301) }, opts)).rejects.toThrow();
    await expect(reopenBankTransaction(org.orgId, txId, opts)).rejects.toBeInstanceOf(BankAllocationError);
    const ig = await ignoreBankTransaction(org.orgId, txId, { reason: "Privatentnahme" }, opts);
    expect(ig.status).toBe("IGNORED");
    expect(ig.ignoredReason).toBe("Privatentnahme");
    await expect(ignoreBankTransaction(other.orgId, txId, { reason: "Privatentnahme" }, opts)).rejects.toBeInstanceOf(NotFoundError);
    const re = await reopenBankTransaction(org.orgId, txId, opts);
    expect(re.status).toBe("OPEN");
    expect(re.ignoredReason).toBeNull();
  });
});
