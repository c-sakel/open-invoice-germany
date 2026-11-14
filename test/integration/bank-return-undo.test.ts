/**
 * Bankabgleich: Zuordnung per Gegenbuchung zuruecknehmen und Ruecklastschriften buchen. Testjahr 2203.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { BankAllocationError, BankConflictError } from "@/domain/bank/errors";
import { confirmBankMatch, ignoreBankTransaction, reopenBankTransaction, undoBankMatch } from "@/domain/bank/confirm";
import { confirmBankReturn, returnSuggestions } from "@/domain/bank/return";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { NotFoundError } from "@/domain/errors";
import { verifyOrgChain } from "@/domain/audit/verify-chain";
import { mkBankOrg, mkBankTx, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2203-03-01T10:00:00.000Z");
const BOOK = new Date("2203-03-05T00:00:00.000Z");
const NOW = new Date("2203-03-06T10:00:00.000Z");
const opts = { actor: "tester", createdBy: "user" as const, now: NOW };
const GROSS = 11900;

let org: BankTestOrg;
let other: BankTestOrg;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  org = await mkBankOrg("Bank Undo GmbH", ISSUE);
  other = await mkBankOrg("Bank Undo Fremd GmbH", ISSUE);
});

async function paid(amount = GROSS, extra: { applySkonto?: boolean; skonto?: boolean; e2e?: string } = {}) {
  const inv = await mkInvoice(org, ISSUE, { skonto: extra.skonto });
  const txId = await mkBankTx(org, { amountCents: amount, bookingDate: BOOK, endToEndId: extra.e2e, remittance: inv.number });
  const r = await confirmBankMatch(
    org.orgId, txId,
    { allocations: [{ invoiceId: inv.id, amountCents: amount, applySkonto: extra.applySkonto }], expectedAllocatedCents: 0 },
    opts,
  );
  const match = await dbInternal.bankMatch.findFirstOrThrow({ where: { transactionId: txId, kind: "PAYMENT" }, select: { id: true } });
  return { inv, txId, paymentId: r.payments[0]!.paymentId, matchId: match.id };
}

const invoiceOf = (id: string) => dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmountCents: true } });

describe("Bankabgleich: Zuordnung zuruecknehmen", () => {
  it("Gegenbuchung mit Grund, Rechnung zurueck, Match UNDO, Umsatz OPEN; zweites Undo und fremde Org scheitern", async () => {
    const p = await paid();
    expect((await invoiceOf(p.inv.id)).status).toBe("PAID");
    const v = await undoBankMatch(org.orgId, p.txId, { matchId: p.matchId, reason: "Falsch zugeordnet" }, opts);
    expect(v.status).toBe("OPEN");
    expect(v.allocatedCents).toBe(0);
    const inv = await invoiceOf(p.inv.id);
    expect(inv.status).toBe("FINALIZED");
    expect(inv.paidAmountCents).toBe(0);
    const rev = await dbInternal.payment.findFirstOrThrow({ where: { reversesPaymentId: p.paymentId } });
    expect(rev).toMatchObject({ kind: "REVERSAL", amountCents: -GROSS, reason: "Falsch zugeordnet" });
    const undo = await dbInternal.bankMatch.findFirstOrThrow({ where: { transactionId: p.txId, kind: "UNDO" } });
    expect(undo.refMatchId).toBe(p.matchId);
    expect(undo.amountCents).toBe(GROSS);
    expect(await dbInternal.bankMatch.count({ where: { transactionId: p.txId, kind: "PAYMENT" } })).toBe(1);
    await expect(undoBankMatch(org.orgId, p.txId, { matchId: p.matchId, reason: "Nochmal" }, opts)).rejects.toBeInstanceOf(BankConflictError);
    await expect(undoBankMatch(other.orgId, p.txId, { matchId: p.matchId, reason: "Fremd" }, opts)).rejects.toBeInstanceOf(NotFoundError);
    const foreignTx = await mkBankTx(other, { amountCents: GROSS, bookingDate: BOOK });
    await expect(undoBankMatch(other.orgId, foreignTx, { matchId: p.matchId, reason: "Fremd" }, opts)).rejects.toBeInstanceOf(NotFoundError);
    // danach erneut zuordenbar; neue Zahlung bekommt eine neue Referenz
    const again = await confirmBankMatch(org.orgId, p.txId, { allocations: [{ invoiceId: p.inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts);
    const pay = await dbInternal.payment.findUniqueOrThrow({ where: { id: again.payments[0]!.paymentId } });
    expect(pay.providerPaymentId).toBe(`${p.txId}:2`);
    expect((await verifyOrgChain(org.orgId, "UI")).valid).toBe(true);
  });

  it("Undo nach Skonto bucht die Skontozahlung mit zurueck", async () => {
    const p = await paid(GROSS - 238, { applySkonto: true, skonto: true });
    expect((await invoiceOf(p.inv.id)).paidAmountCents).toBe(GROSS);
    await undoBankMatch(org.orgId, p.txId, { matchId: p.matchId, reason: "Skonto zurueck" }, opts);
    const inv = await invoiceOf(p.inv.id);
    expect(inv.paidAmountCents).toBe(0);
    expect(inv.status).toBe("FINALIZED");
    expect(await dbInternal.payment.count({ where: { invoiceId: p.inv.id, kind: "REVERSAL" } })).toBe(2);
  });

  it("bereits manuell teilweise gegengebucht: nur der Rest wird gegengebucht", async () => {
    const p = await paid();
    await reversePayment(p.paymentId, { amountCents: 4000, reason: "Teilrueckzahlung" }, { actor: "tester", orgId: org.orgId, now: NOW });
    const v = await undoBankMatch(org.orgId, p.txId, { matchId: p.matchId, reason: "Rest zuruecknehmen" }, opts);
    // die manuelle Teilstornierung hat den Umsatz schon auf 7900 gesenkt; das Undo gibt den Rest frei.
    expect(v.allocatedCents).toBe(0);
    expect(v.status).toBe("OPEN");
    const sum = await dbInternal.payment.aggregate({ where: { reversesPaymentId: p.paymentId }, _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(-GROSS);
    const undos = await dbInternal.bankMatch.findMany({ where: { transactionId: p.txId, kind: "UNDO" }, select: { amountCents: true }, orderBy: { amountCents: "asc" } });
    expect(undos.map((u) => u.amountCents)).toEqual([4000, GROSS - 4000]);
    expect((await invoiceOf(p.inv.id)).paidAmountCents).toBe(0);
  });

  it("manuelle Stornierung einer Bankzahlung schreibt den Umsatz fort (Teil, Undo, Voll)", async () => {
    const p = await paid(10000);
    const txRow = () => dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: p.txId }, select: { allocatedCents: true, status: true } });
    await reversePayment(p.paymentId, { amountCents: 4000, reason: "Teilrueckzahlung" }, { actor: "tester", orgId: org.orgId, now: NOW });
    expect(await txRow()).toEqual({ allocatedCents: 6000, status: "PARTIAL" });
    expect(await dbInternal.bankMatch.count({ where: { transactionId: p.txId, kind: "UNDO", refMatchId: p.matchId, amountCents: 4000 } })).toBe(1);
    await undoBankMatch(org.orgId, p.txId, { matchId: p.matchId, reason: "Rest zuruecknehmen" }, opts);
    expect(await txRow()).toEqual({ allocatedCents: 0, status: "OPEN" });
    expect((await dbInternal.payment.aggregate({ where: { invoiceId: p.inv.id }, _sum: { amountCents: true } }))._sum.amountCents).toBe(0);
    await expect(undoBankMatch(org.orgId, p.txId, { matchId: p.matchId, reason: "Nochmal" }, opts)).rejects.toBeInstanceOf(BankConflictError);

    const q = await paid(10000);
    await reversePayment(q.paymentId, { reason: "Komplett zurueck" }, { actor: "tester", orgId: org.orgId, now: NOW });
    const row = await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: q.txId }, select: { allocatedCents: true, status: true } });
    expect(row).toEqual({ allocatedCents: 0, status: "OPEN" });
    expect((await verifyOrgChain(org.orgId, "UI")).valid).toBe(true);
  });

  it("Stornierung einer Zahlung ohne Bankbezug laesst Bankumsaetze unberuehrt", async () => {
    const own = await paid(10000);
    const inv = await mkInvoice(org, ISSUE);
    const { recordPayment } = await import("@/domain/invoice/payment");
    const manual = await recordPayment(inv.id, { amountCents: GROSS, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: org.orgId, now: NOW });
    const matchesBefore = await dbInternal.bankMatch.count({ where: { orgId: org.orgId } });
    await reversePayment(manual.recorded.id, { reason: "Irrtum" }, { actor: "tester", orgId: org.orgId, now: NOW });
    expect(await dbInternal.bankMatch.count({ where: { orgId: org.orgId } })).toBe(matchesBefore);
    const row = await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: own.txId }, select: { allocatedCents: true, status: true } });
    expect(row).toEqual({ allocatedCents: 10000, status: "MATCHED" });
  });

  it("Undo einer Teilzuordnung laesst den Umsatz PARTIAL", async () => {
    const a = await mkInvoice(org, ISSUE);
    const b = await mkInvoice(org, ISSUE);
    const txId = await mkBankTx(org, { amountCents: 2 * GROSS, bookingDate: BOOK });
    await confirmBankMatch(org.orgId, txId, { allocations: [{ invoiceId: a.id, amountCents: GROSS }, { invoiceId: b.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, opts);
    const matchA = await dbInternal.bankMatch.findFirstOrThrow({ where: { transactionId: txId, invoiceId: a.id, kind: "PAYMENT" } });
    const v = await undoBankMatch(org.orgId, txId, { matchId: matchA.id, reason: "A war falsch" }, opts);
    expect(v.status).toBe("PARTIAL");
    expect(v.allocatedCents).toBe(GROSS);
  });
});

describe("Bankabgleich: Ruecklastschrift", () => {
  it("gleiche EndToEndId -> Vorschlag SAME_E2E; Bestaetigung bucht Gegenbuchung mit Rueckgabecode, RETURN_DONE", async () => {
    const p = await paid(GROSS, { e2e: "E2E-0042" });
    const retTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, direction: "DBIT", status: "RETURN", endToEndId: "E2E-0042", returnReason: "AC04" });
    const sug = await returnSuggestions(org.orgId, retTx);
    expect(sug).toEqual([{ paymentId: p.paymentId, invoiceId: p.inv.id, number: p.inv.number, amountCents: GROSS, reason: "SAME_E2E" }]);
    const res = await confirmBankReturn(org.orgId, retTx, { paymentId: p.paymentId }, opts);
    expect(res.transaction.status).toBe("RETURN_DONE");
    expect(res).toMatchObject({ feeCents: 0, partial: false });
    const rev = await dbInternal.payment.findFirstOrThrow({ where: { reversesPaymentId: p.paymentId } });
    expect(rev.reason).toContain("AC04");
    expect(rev.amountCents).toBe(-GROSS);
    expect((await invoiceOf(p.inv.id)).paidAmountCents).toBe(0);
    const m = await dbInternal.bankMatch.findFirstOrThrow({ where: { transactionId: retTx } });
    expect(m).toMatchObject({ kind: "REVERSAL", refMatchId: p.matchId, paymentId: rev.id });
    await expect(confirmBankReturn(org.orgId, retTx, { paymentId: p.paymentId }, opts)).rejects.toBeInstanceOf(BankAllocationError);
  });

  it("Rueckgabe mit Gebuehr (Umsatz > Zahlung): Gegenbuchung nur bis Zahlbetrag; Nummer im Text liefert Vorschlag NUMBER", async () => {
    const p = await paid();
    const retTx = await mkBankTx(org, { amountCents: GROSS + 600, bookingDate: BOOK, direction: "DBIT", status: "RETURN", returnReason: "MS03", remittance: `Rueckgabe ${p.inv.number}` });
    const sug = await returnSuggestions(org.orgId, retTx);
    expect(sug.map((s) => [s.paymentId, s.reason])).toEqual([[p.paymentId, "NUMBER"]]);
    const res = await confirmBankReturn(org.orgId, retTx, { paymentId: p.paymentId, reason: "Konto aufgeloest" }, opts);
    expect(res).toMatchObject({ feeCents: 600, partial: false });
    const rev = await dbInternal.payment.findFirstOrThrow({ where: { reversesPaymentId: p.paymentId } });
    expect(rev.amountCents).toBe(-GROSS);
    expect(rev.reason).toContain("MS03");
    expect(rev.reason).toContain("Konto aufgeloest");
    expect((await dbInternal.bankTransaction.findUniqueOrThrow({ where: { id: retTx } })).status).toBe("RETURN_DONE");
  });

  it("Zahlung einer fremden Org -> NotFoundError; Umsatz ohne Status RETURN wird nicht gebucht", async () => {
    const foreignInv = await mkInvoice(other, ISSUE);
    const { recordPayment } = await import("@/domain/invoice/payment");
    const fp = await recordPayment(foreignInv.id, { amountCents: GROSS, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: other.orgId, now: NOW });
    const retTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, direction: "DBIT", status: "RETURN" });
    await expect(confirmBankReturn(org.orgId, retTx, { paymentId: fp.recorded.id }, opts)).rejects.toBeInstanceOf(NotFoundError);
    expect(await dbInternal.payment.count({ where: { reversesPaymentId: fp.recorded.id } })).toBe(0);
    const openTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK });
    const own = await paid();
    await expect(confirmBankReturn(org.orgId, openTx, { paymentId: own.paymentId }, opts)).rejects.toBeInstanceOf(BankAllocationError);
    await expect(returnSuggestions(other.orgId, retTx)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("Bankabgleich: Rueckbuchung ohne Gegenbuchung erledigen", () => {
  it("Rueckbuchung mit CRDT ist nicht gegen Kundenzahlungen buchbar; erledigen mit Grund, reopen fuehrt nach RETURN", async () => {
    const p = await paid();
    const retTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, direction: "CRDT", status: "RETURN" });
    await expect(confirmBankReturn(org.orgId, retTx, { paymentId: p.paymentId }, opts)).rejects.toBeInstanceOf(BankAllocationError);
    expect(await dbInternal.payment.count({ where: { reversesPaymentId: p.paymentId } })).toBe(0);
    await expect(ignoreBankTransaction(org.orgId, retTx, { reason: "ab" }, opts)).rejects.toThrow();
    const done = await ignoreBankTransaction(org.orgId, retTx, { reason: "Rueckbuchung Ausgangsbuchung" }, opts);
    expect(done.status).toBe("RETURN_DONE");
    expect(done.ignoredReason).toBe("Rueckbuchung Ausgangsbuchung");
    expect(await dbInternal.payment.count({ where: { reversesPaymentId: p.paymentId } })).toBe(0);
    await expect(confirmBankReturn(org.orgId, retTx, { paymentId: p.paymentId }, opts)).rejects.toBeInstanceOf(BankAllocationError);
    const re = await reopenBankTransaction(org.orgId, retTx, opts);
    expect(re.status).toBe("RETURN");
    expect(re.ignoredReason).toBeNull();
  });

  it("gegengebuchte Rueckbuchung (RETURN_DONE ohne Grund) laesst sich nicht wieder oeffnen", async () => {
    const p = await paid();
    const retTx = await mkBankTx(org, { amountCents: GROSS, bookingDate: BOOK, direction: "DBIT", status: "RETURN" });
    await confirmBankReturn(org.orgId, retTx, { paymentId: p.paymentId }, opts);
    await expect(reopenBankTransaction(org.orgId, retTx, opts)).rejects.toBeInstanceOf(BankAllocationError);
  });

  it("Teil-Rueckgabe (Umsatz kleiner als Zahlung) meldet partial", async () => {
    const p = await paid();
    const retTx = await mkBankTx(org, { amountCents: 3000, bookingDate: BOOK, direction: "DBIT", status: "RETURN" });
    const res = await confirmBankReturn(org.orgId, retTx, { paymentId: p.paymentId }, opts);
    expect(res).toMatchObject({ feeCents: 0, partial: true });
  });
});
