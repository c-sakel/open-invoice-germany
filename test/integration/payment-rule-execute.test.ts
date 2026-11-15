/**
 * Ausfuehrung der Regel-Laeufe: Aktionen genau einmal, parallele Ausfuehrer, Absturz-Wiederaufnahme, Wiederholung mit
 * Backoff, Vorpruefungen, Abo fortsetzen, Mail hoechstens einmal, Anstoss nach dem Commit, Scheduler. Testjahr 2211.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const emitFail = vi.hoisted(() => ({ on: false }));
vi.mock("@/domain/webhook/emit", async (orig) => {
  const actual = await orig<typeof import("@/domain/webhook/emit")>();
  return {
    ...actual,
    emitEvent: vi.fn(async (...args: Parameters<typeof actual.emitEvent>) => {
      if (emitFail.on) throw new Error("Endpunkt nicht erreichbar");
      return actual.emitEvent(...args);
    }),
  };
});

import { dbInternal } from "@/lib/db";
import { saveDocumentSettings } from "@/domain/document/settings";
import { saveMailSettings } from "@/domain/email/settings";
import { createMemoryProvider } from "@/lib/mail/memory";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createRecurring } from "@/domain/recurring/create";
import { paymentRuleKickIdle } from "@/domain/payment-rule/kick";
import { processPaymentRuleRuns, retryPaymentRuleRun, type ConfirmationSender } from "@/domain/payment-rule/execute";
import { runScheduledJobs } from "@/domain/scheduler/runner";
import { createRecurringSchema, recordPaymentSchema } from "@/schemas";
import { mkBankOrg, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2211-03-01T10:00:00.000Z");
const NOW = new Date("2211-03-06T10:00:00.000Z");
const GROSS = 11900;
const pay = (amountCents: number, extra: Record<string, unknown> = {}) =>
  recordPaymentSchema.parse({ amountCents, method: "TRANSFER", paidAt: NOW, ...extra });
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

type Action = Record<string, unknown>;
let seq = 0;
async function mkOrg(): Promise<BankTestOrg> {
  seq += 1;
  const o = await mkBankOrg(`Regel-Ausfuehrung ${seq} GmbH`, ISSUE);
  await saveDocumentSettings(o.orgId, { viesCheckEnabled: false });
  return o;
}
async function mkRule(orgId: string, actions: Action[], extra: { trigger?: string; delayMinutes?: number } = {}): Promise<string> {
  const r = await dbInternal.paymentRule.create({
    data: { orgId, name: "Testregel", trigger: extra.trigger ?? "PAID_FULL", delayMinutes: extra.delayMinutes ?? 0, actionsJson: JSON.stringify(actions) },
    select: { id: true },
  });
  return r.id;
}
async function mkTag(orgId: string, name = "bezahlt"): Promise<string> {
  return (await dbInternal.tag.create({ data: { orgId, name }, select: { id: true } })).id;
}
async function mkEndpoint(orgId: string): Promise<void> {
  await dbInternal.webhookEndpoint.create({
    data: { orgId, url: "https://example.org/hook", secretEnc: "x", eventsJson: JSON.stringify(["payment_rule.triggered"]) },
    select: { id: true },
  });
}
async function paidInvoice(o: BankTestOrg) {
  const inv = await mkInvoice(o, ISSUE);
  const p = await recordPayment(inv.id, pay(GROSS), { orgId: o.orgId, now: NOW });
  return { inv, paymentId: p.recorded.id };
}
const runsOf = (orgId: string) =>
  dbInternal.paymentRuleRun.findMany({
    where: { orgId }, orderBy: { createdAt: "asc" },
    select: { id: true, status: true, attempts: true, nextAttemptAt: true, lockedUntil: true, stepsJson: true, skipReason: true, lastError: true, mailSentAt: true },
  });
const steps = (json: string): { type: string; status: string; note?: string }[] => JSON.parse(json);
const process = (orgId: string, now = NOW, extra: { sendConfirmation?: ConfirmationSender } = {}) => processPaymentRuleRuns({ orgId, now, ...extra });

beforeAll(() => {
  process_env();
});
function process_env(): void {
  globalThis.process.env.AUTH_SECRET = globalThis.process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
}
afterEach(() => {
  emitFail.on = false;
  globalThis.process.env.PAYMENT_RULES_AFTER_COMMIT = "0";
});

describe("Aktionen", () => {
  it("Tag, Benachrichtigung und Webhook -> Lauf DONE, jede Wirkung einmal, zweiter Aufruf ohne Wirkung", async () => {
    const o = await mkOrg();
    await mkEndpoint(o.orgId);
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, [{ type: "ADD_TAG", tagId }, { type: "NOTIFY", note: "Danke" }, { type: "EMIT_WEBHOOK" }]);
    const { inv } = await paidInvoice(o);
    const res = await process(o.orgId);
    expect(res).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("DONE");
    expect(steps(run!.stepsJson).map((s) => s.status)).toEqual(["DONE", "DONE", "DONE"]);
    expect(await dbInternal.documentTag.count({ where: { orgId: o.orgId, tagId, docId: inv.id } })).toBe(1);
    const notes = await dbInternal.notification.findMany({ where: { orgId: o.orgId, type: "PAYMENT_RULE" }, select: { title: true, body: true, link: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain(inv.number);
    expect(notes[0]!.link).toBe(`/rechnungen/${inv.id}`);
    const deliveries = await dbInternal.webhookDelivery.findMany({ where: { orgId: o.orgId }, select: { event: true, dataJson: true } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.event).toBe("payment_rule.triggered");
    expect(deliveries[0]!.dataJson).not.toContain("internalNotes");
    expect(await dbInternal.activityLog.count({ where: { orgId: o.orgId, type: "PAYMENT_RULE_EXECUTED", entityId: inv.id } })).toBe(3);

    expect(await process(o.orgId)).toMatchObject({ claimed: 0 });
    expect(await dbInternal.webhookDelivery.count({ where: { orgId: o.orgId } })).toBe(1);
  });

  it("Wartezeit: Lauf wird vor Ablauf nicht geclaimt", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }], { delayMinutes: 5 });
    await paidInvoice(o);
    expect(await process(o.orgId, at(4))).toMatchObject({ claimed: 0 });
    expect(await process(o.orgId, at(5))).toMatchObject({ claimed: 1, done: 1 });
  });

  it("Tag geloescht -> Schritt SKIPPED, Lauf DONE", async () => {
    const o = await mkOrg();
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, [{ type: "ADD_TAG", tagId }]);
    await paidInvoice(o);
    await dbInternal.tag.delete({ where: { id: tagId } });
    await process(o.orgId);
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("DONE");
    expect(steps(run!.stepsJson)[0]).toMatchObject({ status: "SKIPPED", note: "Tag geloescht" });
  });

  it("Benachrichtigungstyp abgeschaltet -> Schritt SKIPPED", async () => {
    const o = await mkOrg();
    await dbInternal.notificationSettings.create({ data: { orgId: o.orgId, enabledTypesJson: JSON.stringify(["INVOICE_OVERDUE"]) }, select: { id: true } });
    await mkRule(o.orgId, [{ type: "NOTIFY" }]);
    await paidInvoice(o);
    await process(o.orgId);
    const [run] = await runsOf(o.orgId);
    expect(steps(run!.stepsJson)[0]).toMatchObject({ status: "SKIPPED", note: "Benachrichtigungstyp abgeschaltet" });
    expect(await dbInternal.notification.count({ where: { orgId: o.orgId, type: "PAYMENT_RULE" } })).toBe(0);
  });
});

describe("Exklusivitaet und Wiederaufnahme", () => {
  it("parallele Ausfuehrer auf denselben Lauf: nur einer fuehrt aus, jede Wirkung genau einmal", async () => {
    const o = await mkOrg();
    await mkEndpoint(o.orgId);
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, [{ type: "ADD_TAG", tagId }, { type: "NOTIFY" }, { type: "EMIT_WEBHOOK" }]);
    const { inv } = await paidInvoice(o);
    const results = await Promise.all([process(o.orgId), process(o.orgId), process(o.orgId)]);
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.done, 0)).toBe(1);
    expect(await dbInternal.documentTag.count({ where: { orgId: o.orgId, docId: inv.id } })).toBe(1);
    expect(await dbInternal.notification.count({ where: { orgId: o.orgId, type: "PAYMENT_RULE" } })).toBe(1);
    expect(await dbInternal.webhookDelivery.count({ where: { orgId: o.orgId } })).toBe(1);
  });

  it("Absturz: RUNNING mit abgelaufener Sperre, Schritt 1 erledigt -> Wiederaufnahme ab Schritt 2", async () => {
    const o = await mkOrg();
    await mkEndpoint(o.orgId);
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, [{ type: "ADD_TAG", tagId }, { type: "EMIT_WEBHOOK" }]);
    const { inv } = await paidInvoice(o);
    const [run] = await runsOf(o.orgId);
    await dbInternal.documentTag.create({ data: { orgId: o.orgId, tagId, docType: "INVOICE", docId: inv.id }, select: { id: true } });
    await dbInternal.paymentRuleRun.update({
      where: { id: run!.id },
      data: { status: "RUNNING", lockedUntil: at(-1), attempts: 1, stepsJson: JSON.stringify([{ type: "ADD_TAG", status: "DONE" }, { type: "EMIT_WEBHOOK", status: "PENDING" }]) },
    });
    expect(await process(o.orgId, at(10))).toMatchObject({ claimed: 1, done: 1 });
    expect(await dbInternal.webhookDelivery.count({ where: { orgId: o.orgId } })).toBe(1);
    expect(await dbInternal.documentTag.count({ where: { orgId: o.orgId, docId: inv.id } })).toBe(1);
    // Solange die Sperre gilt, nimmt niemand den Lauf auf.
    const o2 = await mkOrg();
    await mkRule(o2.orgId, [{ type: "NOTIFY" }]);
    await paidInvoice(o2);
    const [r2] = await runsOf(o2.orgId);
    await dbInternal.paymentRuleRun.update({ where: { id: r2!.id }, data: { status: "RUNNING", lockedUntil: at(5) } });
    expect(await process(o2.orgId, at(1))).toMatchObject({ claimed: 0 });
  });

  it("Status nur vorwaerts: ein beendeter Lauf wird nie erneut geclaimt", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }]);
    await paidInvoice(o);
    await process(o.orgId);
    expect(await process(o.orgId, at(600))).toMatchObject({ claimed: 0 });
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("DONE");
  });
});

describe("Fehler und Wiederholung", () => {
  it("Fehler -> PENDING mit Backoff, nach fuenf Versuchen FAILED mit einer Benachrichtigung, Retry setzt nur den Fehlschritt zurueck", async () => {
    const o = await mkOrg();
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, [{ type: "ADD_TAG", tagId }, { type: "EMIT_WEBHOOK" }]);
    await paidInvoice(o);
    emitFail.on = true;
    let now = NOW;
    expect(await process(o.orgId, now)).toMatchObject({ claimed: 1, retry: 1 });
    let [run] = await runsOf(o.orgId);
    expect(run).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(run!.nextAttemptAt.getTime()).toBe(now.getTime() + 60_000);
    expect(steps(run!.stepsJson).map((s) => s.status)).toEqual(["DONE", "FAILED"]);
    for (const minutes of [1, 5, 30, 120]) {
      now = new Date(now.getTime() + minutes * 60_000);
      await process(o.orgId, now);
    }
    [run] = await runsOf(o.orgId);
    expect(run).toMatchObject({ status: "FAILED", attempts: 5 });
    expect(run!.lastError).toContain("Endpunkt nicht erreichbar");
    expect(await dbInternal.notification.count({ where: { orgId: o.orgId, type: "PAYMENT_RULE_FAILED" } })).toBe(1);

    emitFail.on = false;
    await mkEndpoint(o.orgId);
    const view = await retryPaymentRuleRun(o.orgId, run!.id, "tester");
    expect(view).toMatchObject({ status: "PENDING", attempts: 0 });
    await process(o.orgId, new Date(now.getTime() + 1000));
    [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("DONE");
    expect(steps(run!.stepsJson).map((s) => s.status)).toEqual(["DONE", "DONE"]);
    expect(await dbInternal.documentTag.count({ where: { orgId: o.orgId, tagId } })).toBe(1);
    await expect(retryPaymentRuleRun(o.orgId, run!.id, "tester")).rejects.toThrow();
  });
});

describe("Vorpruefung", () => {
  it("Gegenbuchung vor der Ausfuehrung -> SKIPPED", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }]);
    const { paymentId } = await paidInvoice(o);
    await reversePayment(paymentId, { reason: "Fehlbuchung" }, { actor: "t", orgId: o.orgId, now: NOW });
    await process(o.orgId);
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("SKIPPED");
  });

  it("Rueckbuchung einer fruehen Zahlung macht den PAID_FULL-Lauf der spaeteren Zahlung unwirksam", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }]);
    const inv = await mkInvoice(o, ISSUE);
    const p1 = await recordPayment(inv.id, pay(3000), { orgId: o.orgId, now: NOW });
    await recordPayment(inv.id, pay(GROSS - 3000), { orgId: o.orgId, now: NOW });
    await reversePayment(p1.recorded.id, { reason: "Fehlbuchung" }, { actor: "t", orgId: o.orgId, now: NOW });
    await process(o.orgId);
    const [run] = await runsOf(o.orgId);
    expect(run).toMatchObject({ status: "SKIPPED", skipReason: "nicht mehr vollstaendig bezahlt" });
    expect(await dbInternal.notification.count({ where: { orgId: o.orgId, type: "PAYMENT_RULE" } })).toBe(0);
  });

  it("Gegenbuchung einer Zahlung mit Skonto -> Lauf SKIPPED", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }]);
    const inv = await mkInvoice(o, ISSUE, { skonto: true });
    const res = await recordPayment(inv.id, pay(GROSS - 238, { applySkonto: true, paidAt: new Date("2211-03-05T00:00:00.000Z") }), { orgId: o.orgId, now: NOW });
    await reversePayment(res.recorded.id, { reason: "Skonto zu Unrecht" }, { actor: "t", orgId: o.orgId, now: NOW });
    await process(o.orgId);
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("SKIPPED");
  });

  it("Rechnung storniert oder Regel archiviert -> SKIPPED", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }], { trigger: "PAID_PARTIAL" });
    const inv = await mkInvoice(o, ISSUE);
    await recordPayment(inv.id, pay(2000), { orgId: o.orgId, now: NOW });
    await cancelInvoice(inv.id, { orgId: o.orgId, now: NOW, reason: "Test" } as Parameters<typeof cancelInvoice>[1]);
    await process(o.orgId);
    expect((await runsOf(o.orgId))[0]!.status).toBe("SKIPPED");

    const o2 = await mkOrg();
    const ruleId = await mkRule(o2.orgId, [{ type: "NOTIFY" }]);
    await paidInvoice(o2);
    await dbInternal.paymentRule.update({ where: { id: ruleId }, data: { archivedAt: NOW, active: false } });
    await process(o2.orgId);
    expect((await runsOf(o2.orgId))[0]!.skipReason).toBe("Regel deaktiviert");
  });
});

describe("Abo fortsetzen", () => {
  async function mkAbo(o: BankTestOrg, status: string, nextRunDate: Date) {
    const rec = await createRecurring(
      o.orgId,
      createRecurringSchema.parse({
        customerId: o.customerId, title: "Wartung", startDate: new Date("2211-01-15T10:00:00.000Z"),
        lines: [{ lineType: "ITEM", description: "Grundgebühr", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      }),
    );
    await dbInternal.recurringInvoice.update({ where: { id: rec.id }, data: { status, nextRunDate } });
    return rec.id;
  }
  const recOf = (id: string) => dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id }, select: { status: true, nextRunDate: true, issuedCount: true } });

  it("SKIP: Einzel-Abo wird ACTIVE, Termin rueckt vor, issuedCount unveraendert; BILL laesst den Termin", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "RESUME_RECURRING", missedPeriods: "SKIP" }]);
    const { inv } = await paidInvoice(o);
    const old = new Date(2211, 0, 15, 12);
    const abo = await mkAbo(o, "PAUSED", old);
    await dbInternal.invoice.update({ where: { id: inv.id }, data: { recurringInvoiceId: abo } });
    await process(o.orgId);
    const after = await recOf(abo);
    expect(after.status).toBe("ACTIVE");
    expect(after.nextRunDate.getTime()).toBeGreaterThan(old.getTime());
    expect(after.nextRunDate.getTime()).toBeGreaterThanOrEqual(new Date(2211, 2, 6).getTime());
    expect(after.issuedCount).toBe(0);

    const o2 = await mkOrg();
    await mkRule(o2.orgId, [{ type: "RESUME_RECURRING", missedPeriods: "BILL" }]);
    const p2 = await paidInvoice(o2);
    const abo2 = await mkAbo(o2, "PAUSED", old);
    await dbInternal.invoice.update({ where: { id: p2.inv.id }, data: { recurringInvoiceId: abo2 } });
    await process(o2.orgId);
    const after2 = await recOf(abo2);
    expect(after2.status).toBe("ACTIVE");
    expect(after2.nextRunDate.getTime()).toBe(old.getTime());
  });

  it("Sammelrechnung: beide pausierten Abos ACTIVE, beendetes bleibt ENDED, aktives unveraendert", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "RESUME_RECURRING", missedPeriods: "SKIP" }]);
    const { inv } = await paidInvoice(o);
    const old = new Date(2211, 0, 15, 12);
    const ids = [await mkAbo(o, "PAUSED", old), await mkAbo(o, "PAUSED", old), await mkAbo(o, "ENDED", old), await mkAbo(o, "ACTIVE", old)];
    for (const toId of ids) {
      await dbInternal.documentRelation.create({
        data: { orgId: o.orgId, fromType: "INVOICE", fromId: inv.id, toType: "RECURRING", toId, relationType: "GENERATED_BY" }, select: { id: true },
      });
    }
    await process(o.orgId);
    expect((await Promise.all(ids.map(recOf))).map((r) => r.status)).toEqual(["ACTIVE", "ACTIVE", "ENDED", "ACTIVE"]);
    expect((await recOf(ids[3]!)).nextRunDate.getTime()).toBe(old.getTime());
  });

  it("ohne Abo -> Schritt SKIPPED", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "RESUME_RECURRING", missedPeriods: "SKIP" }]);
    await paidInvoice(o);
    await process(o.orgId);
    expect(steps((await runsOf(o.orgId))[0]!.stepsJson)[0]).toMatchObject({ status: "SKIPPED", note: "keine Abos" });
  });
});

describe("Mail hoechstens einmal", () => {
  it("zwei parallele Ausfuehrer -> genau ein Versand; Folgeversuch nach Fehler sendet nicht erneut", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "SEND_PAYMENT_CONFIRMATION", templateId: null }]);
    await paidInvoice(o);
    const send = vi.fn<ConfirmationSender>(async () => ({ status: "DONE" }));
    await Promise.all([process(o.orgId, NOW, { sendConfirmation: send }), process(o.orgId, NOW, { sendConfirmation: send })]);
    expect(send).toHaveBeenCalledTimes(1);
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("DONE");
    expect(run!.mailSentAt).not.toBeNull();

    const o2 = await mkOrg();
    await mkRule(o2.orgId, [{ type: "SEND_PAYMENT_CONFIRMATION", templateId: null }]);
    await paidInvoice(o2);
    const failing = vi.fn<ConfirmationSender>(async () => {
      throw new Error("SMTP down");
    });
    await process(o2.orgId, NOW, { sendConfirmation: failing });
    await process(o2.orgId, at(2), { sendConfirmation: failing });
    expect(failing).toHaveBeenCalledTimes(1);
    // Claim steht ohne Versandnachweis: Versand unklar, kein weiterer Versuch.
    const unclear = (await runsOf(o2.orgId))[0]!;
    expect(unclear.status).toBe("FAILED");
    expect(unclear.lastError).toContain("Versand unklar");
  });
});

describe("Anstoss und Scheduler", () => {
  it("nach dem Commit der Zahlung fuehrt der Anstoss (PAYMENT_RULES_AFTER_COMMIT=1) den Lauf echt aus", async () => {
    const o = await mkOrg();
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, [{ type: "ADD_TAG", tagId }, { type: "NOTIFY" }]);
    const inv = await mkInvoice(o, ISSUE);
    globalThis.process.env.PAYMENT_RULES_AFTER_COMMIT = "1";
    const nowReal = new Date();
    await recordPayment(inv.id, pay(GROSS, { paidAt: nowReal }), { orgId: o.orgId, now: nowReal });
    await paymentRuleKickIdle();
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("DONE");
    expect(await dbInternal.documentTag.count({ where: { orgId: o.orgId, tagId, docId: inv.id } })).toBe(1);
    expect(await dbInternal.notification.count({ where: { orgId: o.orgId, type: "PAYMENT_RULE" } })).toBe(1);
  });

  it("Scheduler-Job payment-rules fuehrt faellige Laeufe aus", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }]);
    await paidInvoice(o);
    const results = await runScheduledJobs({ jobs: ["payment-rules"], trigger: "MANUAL", now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ job: "payment-rules", ok: true });
    expect((await runsOf(o.orgId))[0]!.status).toBe("DONE");
  });
});

describe("Mail-Schritt blockiert keine Datenbankaktionen", () => {
  async function mkAboFor(o: BankTestOrg, invoiceId: string): Promise<string> {
    const rec = await createRecurring(
      o.orgId,
      createRecurringSchema.parse({
        customerId: o.customerId, title: "Wartung", startDate: new Date("2211-01-15T10:00:00.000Z"),
        lines: [{ lineType: "ITEM", description: "Grundgebühr", quantityMilli: 1000, unitNetPriceCents: 2900, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 }],
      }),
    );
    await dbInternal.recurringInvoice.update({ where: { id: rec.id }, data: { status: "PAUSED", nextRunDate: new Date(2211, 0, 15, 12) } });
    await dbInternal.invoice.update({ where: { id: invoiceId }, data: { recurringInvoiceId: rec.id } });
    return rec.id;
  }
  const mailFirst = (tagId: string): Action[] => [
    { type: "SEND_PAYMENT_CONFIRMATION", templateId: null }, { type: "ADD_TAG", tagId }, { type: "RESUME_RECURRING", missedPeriods: "SKIP" },
  ];

  it("ohne Mail-Einstellungen: Tag und Abo sofort, Mail-Schritt uebersprungen, Lauf DONE", async () => {
    const o = await mkOrg();
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, mailFirst(tagId));
    const { inv } = await paidInvoice(o);
    const abo = await mkAboFor(o, inv.id);
    expect(await process(o.orgId)).toMatchObject({ claimed: 1, done: 1, retry: 0 });
    expect(await dbInternal.documentTag.count({ where: { orgId: o.orgId, tagId, docId: inv.id } })).toBe(1);
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: abo }, select: { status: true } })).status).toBe("ACTIVE");
    const [run] = await runsOf(o.orgId);
    expect(steps(run!.stepsJson).find((s) => s.type === "SEND_PAYMENT_CONFIRMATION")).toMatchObject({ status: "SKIPPED", note: "Keine Mail-Einstellungen hinterlegt" });
  });

  it("Versand unklar: Tag und Abo erledigt, Lauf FAILED, genau ein Versandversuch", async () => {
    const o = await mkOrg();
    await saveMailSettings(o.orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Regel GmbH", fromEmail: "rechnung@example.org", copyToSelf: false, defaultCc: "", defaultBcc: "" });
    await dbInternal.customer.update({ where: { id: o.customerId }, data: { invoiceEmail: "rechnung@kunde.example.org" }, select: { id: true } });
    const tagId = await mkTag(o.orgId);
    await mkRule(o.orgId, mailFirst(tagId));
    const { inv } = await paidInvoice(o);
    const abo = await mkAboFor(o, inv.id);
    const provider = createMemoryProvider();
    provider.failNext("SMTP down");
    expect(await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider })).toMatchObject({ claimed: 1, failed: 1 });
    expect(await dbInternal.documentTag.count({ where: { orgId: o.orgId, tagId, docId: inv.id } })).toBe(1);
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: abo }, select: { status: true } })).status).toBe("ACTIVE");
    const [run] = await runsOf(o.orgId);
    expect(run).toMatchObject({ status: "FAILED" });
    expect(run!.lastError).toContain("Versand unklar");
    expect(await dbInternal.emailLog.count({ where: { orgId: o.orgId, docType: "PAYMENT_CONFIRMATION" } })).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });

  it("verschobener Mail-Schritt (Versandgrenze) haelt den Webhook nicht auf", async () => {
    const o = await mkOrg();
    await mkEndpoint(o.orgId);
    await mkRule(o.orgId, [{ type: "SEND_PAYMENT_CONFIRMATION", templateId: null }, { type: "EMIT_WEBHOOK" }]);
    await paidInvoice(o);
    const defer: ConfirmationSender = async () => ({ status: "DEFER", until: at(30), note: "Versandgrenze je Kunde erreicht" });
    expect(await process(o.orgId, NOW, { sendConfirmation: defer })).toMatchObject({ claimed: 1, deferred: 1 });
    expect(await dbInternal.webhookDelivery.count({ where: { orgId: o.orgId, event: "payment_rule.triggered" } })).toBe(1);
    const [run] = await runsOf(o.orgId);
    expect(run!.status).toBe("PENDING");
  });

  it("Abo mit weiterer offener Rechnung bleibt pausiert, Schritt uebersprungen", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "RESUME_RECURRING", missedPeriods: "SKIP" }]);
    const { inv } = await paidInvoice(o);
    const abo = await mkAboFor(o, inv.id);
    const other = await mkInvoice(o, ISSUE);
    await dbInternal.invoice.update({ where: { id: other.id }, data: { recurringInvoiceId: abo } });
    await process(o.orgId);
    expect((await dbInternal.recurringInvoice.findUniqueOrThrow({ where: { id: abo }, select: { status: true } })).status).toBe("PAUSED");
    const [run] = await runsOf(o.orgId);
    expect(steps(run!.stepsJson)[0]).toMatchObject({ status: "SKIPPED", note: "Weitere offene Rechnung des Abos" });
  });

  it("Tag und Webhook schreiben je einen Aktivitaetseintrag, auch wenn ein spaeterer Schritt scheitert", async () => {
    const o = await mkOrg();
    await mkEndpoint(o.orgId);
    await mkRule(o.orgId, [{ type: "NOTIFY" }, { type: "EMIT_WEBHOOK" }]);
    const { inv } = await paidInvoice(o);
    await process(o.orgId);
    const logs = await dbInternal.activityLog.findMany({ where: { orgId: o.orgId, type: "PAYMENT_RULE_EXECUTED", entityId: inv.id }, select: { dataJson: true } });
    const stepsLogged = logs.map((l) => (JSON.parse(l.dataJson ?? "{}") as { step?: string }).step).filter((x) => x !== undefined).sort();
    expect(stepsLogged).toEqual(["EMIT_WEBHOOK", "NOTIFY"]);
  });
});

describe("Unerwartete Fehler", () => {
  it("defekte Aktionsdaten -> Lauf FAILED und Benachrichtigung mit festem Text", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, [{ type: "NOTIFY" }]);
    await paidInvoice(o);
    const [run] = await runsOf(o.orgId);
    await dbInternal.paymentRuleRun.update({ where: { id: run!.id }, data: { actionsJson: "{kaputt" } });
    expect(await process(o.orgId)).toMatchObject({ claimed: 1, failed: 1 });
    const notes = await dbInternal.notification.findMany({ where: { orgId: o.orgId, type: "PAYMENT_RULE_FAILED" }, select: { body: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Aktion fehlgeschlagen – Details im Server-Protokoll");
  });
});
