/**
 * Regel-Laeufe entstehen mit der Zahlung (Outbox): Ausloeser, Quellen, Filter, Rollback, Gegenbuchung,
 * Schleifenbremse, Anstoss nach dem Commit. Testjahr 2210 (Belegnummern sind global eindeutig).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const processSpy = vi.hoisted(() => vi.fn(async () => ({ claimed: 0, done: 0, failed: 0, skipped: 0, deferred: 0, retry: 0 })));
vi.mock("@/domain/payment-rule/execute", () => ({ processPaymentRuleRuns: processSpy }));

import { dbInternal } from "@/lib/db";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createInvoiceComplete } from "@/domain/invoice/create-complete";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { PaymentError, recordPayment, recordPaymentWithinTx } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { confirmBankMatch } from "@/domain/bank/confirm";
import { RUNS_PER_RULE_AND_INVOICE_MAX } from "@/domain/payment-rule/enqueue";
import { paymentRuleKickIdle } from "@/domain/payment-rule/kick";
import { createInvoiceSchema, recordPaymentSchema } from "@/schemas";
import { mkBankOrg, mkBankTx, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2210-03-01T10:00:00.000Z");
const NOW = new Date("2210-03-06T10:00:00.000Z");
const GROSS = 11900;
const pay = (amountCents: number, extra: Record<string, unknown> = {}) =>
  recordPaymentSchema.parse({ amountCents, method: "TRANSFER", paidAt: NOW, ...extra });

let seq = 0;
async function mkOrg(): Promise<BankTestOrg> {
  seq += 1;
  const o = await mkBankOrg(`Regel-Lauf ${seq} GmbH`, ISSUE);
  await saveDocumentSettings(o.orgId, { viesCheckEnabled: false });
  return o;
}
async function mkRule(
  orgId: string,
  trigger: "PAID_FULL" | "PAID_PARTIAL",
  extra: { sourcesJson?: string | null; invoiceTagId?: string | null; delayMinutes?: number; active?: boolean; archivedAt?: Date | null } = {},
): Promise<string> {
  const r = await dbInternal.paymentRule.create({
    data: { orgId, name: `Regel ${trigger}`, trigger, delayMinutes: 5, actionsJson: JSON.stringify([{ type: "EMIT_WEBHOOK" }]), ...extra },
    select: { id: true },
  });
  return r.id;
}
const runs = (orgId: string) =>
  dbInternal.paymentRuleRun.findMany({
    where: { orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true, ruleId: true, paymentId: true, trigger: true, source: true, status: true, skipReason: true, nextAttemptAt: true, stepsJson: true, contextJson: true },
  });

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
});
afterEach(() => {
  process.env.PAYMENT_RULES_AFTER_COMMIT = "0";
  processSpy.mockClear();
});

describe("Laeufe entstehen mit der Zahlung", () => {
  it("Teilzahlung -> Lauf PAID_PARTIAL mit Kontext, Restzahlung -> Lauf PAID_FULL; Wartezeit und Schritte", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_PARTIAL");
    await mkRule(o.orgId, "PAID_FULL");
    const inv = await mkInvoice(o, ISSUE);
    await recordPayment(inv.id, pay(5000), { orgId: o.orgId, now: NOW });
    let all = await runs(o.orgId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ trigger: "PAID_PARTIAL", source: "MANUAL", status: "PENDING" });
    expect(JSON.parse(all[0]!.contextJson)).toMatchObject({ amountCents: 5000, openAfterCents: GROSS - 5000, currency: "EUR", invoiceNumber: inv.number });
    expect(all[0]!.nextAttemptAt.getTime()).toBe(NOW.getTime() + 5 * 60_000);
    expect(JSON.parse(all[0]!.stepsJson)).toEqual([{ type: "EMIT_WEBHOOK", status: "PENDING" }]);

    await recordPayment(inv.id, pay(GROSS - 5000), { orgId: o.orgId, now: NOW });
    all = await runs(o.orgId);
    expect(all.map((r) => r.trigger)).toEqual(["PAID_PARTIAL", "PAID_FULL"]);
  });

  it("Zahlung mit Skonto -> ein Lauf PAID_FULL an der Primaerzahlung, keiner an der Skontozahlung", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_FULL");
    const inv = await mkInvoice(o, ISSUE, { skonto: true });
    const res = await recordPayment(inv.id, pay(GROSS - 238, { applySkonto: true, paidAt: new Date("2210-03-05T00:00:00.000Z") }), { orgId: o.orgId, now: NOW });
    expect(res.skontoPayment).toBeDefined();
    const all = await runs(o.orgId);
    expect(all).toHaveLength(1);
    expect(all[0]!.paymentId).toBe(res.recorded.id);
    expect(all[0]!.trigger).toBe("PAID_FULL");
  });

  it("Quelle je Erfasser: user -> MANUAL, api -> API, mcp -> MCP", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_PARTIAL");
    const inv = await mkInvoice(o, ISSUE);
    for (const [createdBy, amount] of [["user", 1000], ["api", 1000], ["mcp", 1000]] as const) {
      await recordPayment(inv.id, pay(amount), { orgId: o.orgId, now: NOW, createdBy });
    }
    expect((await runs(o.orgId)).map((r) => r.source)).toEqual(["MANUAL", "API", "MCP"]);
  });

  it("Bankabgleich -> BANK; Regel nur fuer BANK erzeugt nur dort einen Lauf", async () => {
    const o = await mkOrg();
    const ruleId = await mkRule(o.orgId, "PAID_FULL", { sourcesJson: JSON.stringify(["BANK"]) });
    const manual = await mkInvoice(o, ISSUE);
    await recordPayment(manual.id, pay(GROSS), { orgId: o.orgId, now: NOW });
    expect(await runs(o.orgId)).toHaveLength(0);

    const inv = await mkInvoice(o, ISSUE);
    const txId = await mkBankTx(o, { amountCents: GROSS, bookingDate: NOW, remittance: `Rechnung ${inv.number}` });
    await confirmBankMatch(o.orgId, txId, { allocations: [{ invoiceId: inv.id, amountCents: GROSS }], expectedAllocatedCents: 0 }, { actor: "tester", createdBy: "user", now: NOW });
    const all = await runs(o.orgId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ ruleId, source: "BANK", trigger: "PAID_FULL" });
  });

  it("atomares Anlegen mit Zahlung -> Quelle API; Fehler vor dem Commit -> weder Rechnung noch Zahlung noch Lauf", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_FULL");
    const input = createInvoiceSchema.parse({
      customerId: o.customerId,
      issueDate: ISSUE,
      deliveryDate: ISSUE,
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    });
    const noNet = (): Promise<Response> => Promise.reject(new Error("kein Netz im Test"));
    await expect(
      createInvoiceComplete(o.orgId, input, {
        payment: { method: "TRANSFER" },
        actor: "api",
        createdBy: "api",
        now: ISSUE,
        fetchImpl: noNet,
        beforeCommit: async () => {
          throw new Error("Abbruch");
        },
      }),
    ).rejects.toThrow("Abbruch");
    expect(await runs(o.orgId)).toHaveLength(0);
    expect(await dbInternal.invoice.count({ where: { orgId: o.orgId } })).toBe(0);

    const ok = await createInvoiceComplete(o.orgId, input, { payment: { method: "TRANSFER" }, actor: "api", createdBy: "api", now: ISSUE, fetchImpl: noNet });
    const all = await runs(o.orgId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ source: "API", trigger: "PAID_FULL", paymentId: ok.paymentId });
  });

  it("Rollback der Zahlungs-Transaktion nimmt den Lauf mit", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_FULL");
    const inv = await mkInvoice(o, ISSUE);
    await expect(
      dbInternal.$transaction(async (tx) => {
        await recordPaymentWithinTx(tx, inv.id, pay(GROSS), { orgId: o.orgId, now: NOW });
        throw new Error("Abbruch");
      }),
    ).rejects.toThrow("Abbruch");
    expect(await runs(o.orgId)).toHaveLength(0);
    expect(await dbInternal.payment.count({ where: { invoiceId: inv.id } })).toBe(0);
  });

  it("Rechnungs-Tag-Filter: ohne Tag kein Lauf, mit Tag ein Lauf", async () => {
    const o = await mkOrg();
    const tag = await dbInternal.tag.create({ data: { orgId: o.orgId, name: "Stammkunde" }, select: { id: true } });
    await mkRule(o.orgId, "PAID_FULL", { invoiceTagId: tag.id });
    const plain = await mkInvoice(o, ISSUE);
    await recordPayment(plain.id, pay(GROSS), { orgId: o.orgId, now: NOW });
    expect(await runs(o.orgId)).toHaveLength(0);
    const tagged = await mkInvoice(o, ISSUE);
    await dbInternal.documentTag.create({ data: { orgId: o.orgId, tagId: tag.id, docType: "INVOICE", docId: tagged.id }, select: { id: true } });
    await recordPayment(tagged.id, pay(GROSS), { orgId: o.orgId, now: NOW });
    expect(await runs(o.orgId)).toHaveLength(1);
  });

  it("Verrechnung mit einer Gutschrift schliesst die Rechnung, loest aber nichts aus", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_FULL");
    const inv = await mkInvoice(o, ISSUE);
    await createPartialCreditNote(
      inv.id,
      { lines: [{ description: "Gutschrift", quantityMilli: 1000, unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }] },
      { orgId: o.orgId, now: NOW },
    );
    const row = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { status: true } });
    expect(row.status).toBe("PAID");
    expect(await runs(o.orgId)).toHaveLength(0);
  });

  it("inaktive, archivierte und fremde Regeln erzeugen keinen Lauf", async () => {
    const o = await mkOrg();
    const other = await mkOrg();
    await mkRule(o.orgId, "PAID_FULL", { active: false });
    await mkRule(o.orgId, "PAID_FULL", { archivedAt: new Date() });
    await mkRule(other.orgId, "PAID_FULL");
    const inv = await mkInvoice(o, ISSUE);
    await recordPayment(inv.id, pay(GROSS), { orgId: o.orgId, now: NOW });
    expect(await runs(o.orgId)).toHaveLength(0);
    expect(await runs(other.orgId)).toHaveLength(0);
  });
});

describe("Gegenbuchung", () => {
  it("haelt offene Laeufe an (voll und teilweise), erledigte bleiben, neuer Lauf entsteht nicht", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_PARTIAL");
    const inv = await mkInvoice(o, ISSUE);
    const p1 = await recordPayment(inv.id, pay(3000), { orgId: o.orgId, now: NOW });
    const p2 = await recordPayment(inv.id, pay(3000), { orgId: o.orgId, now: NOW });
    const p3 = await recordPayment(inv.id, pay(3000), { orgId: o.orgId, now: NOW });
    await dbInternal.paymentRuleRun.updateMany({ where: { paymentId: p3.recorded.id }, data: { status: "DONE", finishedAt: NOW } });

    await reversePayment(p1.recorded.id, { reason: "Fehlbuchung" }, { actor: "t", orgId: o.orgId, now: NOW });
    await reversePayment(p2.recorded.id, { amountCents: 1000, reason: "Teilrueckbuchung" }, { actor: "t", orgId: o.orgId, now: NOW });
    await reversePayment(p3.recorded.id, { reason: "Fehlbuchung" }, { actor: "t", orgId: o.orgId, now: NOW });

    const all = await runs(o.orgId);
    expect(all).toHaveLength(3);
    const byPayment = new Map(all.map((r) => [r.paymentId, r]));
    expect(byPayment.get(p1.recorded.id)).toMatchObject({ status: "SKIPPED", skipReason: "Zahlung gegengebucht" });
    expect(byPayment.get(p2.recorded.id)).toMatchObject({ status: "SKIPPED", skipReason: "Zahlung gegengebucht" });
    expect(byPayment.get(p3.recorded.id)?.status).toBe("DONE");
    expect(JSON.parse(byPayment.get(p1.recorded.id)!.stepsJson)).toEqual([{ type: "EMIT_WEBHOOK", status: "SKIPPED", note: "Zahlung gegengebucht" }]);
  });
});

describe("Schleifenbremse", () => {
  it("der 21. Lauf je Regel und Rechnung wird nur protokolliert (SKIPPED)", async () => {
    const o = await mkOrg();
    const ruleId = await mkRule(o.orgId, "PAID_PARTIAL");
    const inv = await mkInvoice(o, ISSUE);
    for (let i = 0; i < RUNS_PER_RULE_AND_INVOICE_MAX; i++) {
      await dbInternal.paymentRuleRun.create({
        data: {
          orgId: o.orgId, ruleId, paymentId: `vorhanden-${i}`, invoiceId: inv.id, customerId: o.customerId, trigger: "PAID_PARTIAL", source: "MANUAL",
          actionsJson: "[]", stepsJson: "[]", contextJson: "{}", status: "DONE", nextAttemptAt: NOW, finishedAt: NOW,
        },
        select: { id: true },
      });
    }
    const res = await recordPayment(inv.id, pay(1000), { orgId: o.orgId, now: NOW });
    const run = await dbInternal.paymentRuleRun.findFirstOrThrow({ where: { paymentId: res.recorded.id }, select: { status: true, skipReason: true, stepsJson: true } });
    expect(run).toMatchObject({ status: "SKIPPED", skipReason: "Obergrenze je Rechnung erreicht" });
    expect(JSON.parse(run.stepsJson)[0].status).toBe("SKIPPED");
  });
});

describe("Anstoss nach dem Commit", () => {
  it("recordPayment startet den Ausfuehrer fuer die Organisation; Standard der Tests ohne Anstoss", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_FULL", { delayMinutes: 0 });
    const first = await mkInvoice(o, ISSUE);
    await recordPayment(first.id, pay(GROSS), { orgId: o.orgId, now: NOW });
    await paymentRuleKickIdle();
    expect(processSpy).not.toHaveBeenCalled();

    process.env.PAYMENT_RULES_AFTER_COMMIT = "1";
    const second = await mkInvoice(o, ISSUE);
    await recordPayment(second.id, pay(GROSS), { orgId: o.orgId, now: NOW });
    await paymentRuleKickIdle();
    expect(processSpy).toHaveBeenCalledWith({ orgId: o.orgId, limit: 20 });
  });

  it("ein gescheiterter Aufruf (Zahlung wird abgelehnt) stoesst nichts an", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, "PAID_FULL");
    process.env.PAYMENT_RULES_AFTER_COMMIT = "1";
    const inv = await mkInvoice(o, ISSUE);
    await expect(recordPayment(inv.id, pay(GROSS + 1), { orgId: o.orgId, now: NOW })).rejects.toBeInstanceOf(PaymentError);
    await paymentRuleKickIdle();
    expect(processSpy).not.toHaveBeenCalled();
    expect(await runs(o.orgId)).toHaveLength(0);
  });
});
