/**
 * Zahlungsbestaetigung per Mail: Vorlage, Platzhalter, Protokoll unter der Zahlung, Versandgrenzen,
 * Portal-Link im Protokoll geschwaerzt, kein Rechnungsversand. Kein echter Mailversand (Speicher-Provider). Testjahr 2212.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { saveDocumentSettings } from "@/domain/document/settings";
import { saveMailSettings } from "@/domain/email/settings";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { listInvoices } from "@/domain/invoice/list";
import { createPortalLink } from "@/domain/portal/link";
import { savePortalSettings } from "@/domain/portal/settings";
import { processPaymentRuleRuns, retryPaymentRuleRun } from "@/domain/payment-rule/execute";
import { CONFIRMATION_MAX_PER_CUSTOMER_HOUR, CONFIRMATION_MAX_PER_ORG_HOUR } from "@/domain/payment-rule/mail";
import { sampleTemplateContext } from "@/domain/email/context";
import { createMemoryProvider } from "@/lib/mail/memory";
import { emailTemplateInputSchema, sendEmailInputSchema, EMAIL_TEMPLATE_DOC_TYPES } from "@/schemas/email";
import { DEFAULT_EMAIL_TEMPLATES, DEFAULT_EMAIL_TEMPLATES_EN } from "@/domain/masterdata/defaults";
import { recordPaymentSchema } from "@/schemas";
import { mkBankOrg, mkInvoice, type BankTestOrg } from "../helpers/bank-fixtures";

const ISSUE = new Date("2212-03-01T10:00:00.000Z");
const NOW = new Date("2212-03-06T10:00:00.000Z");
const GROSS = 11900;
const BASE = "https://rechnung.example.test";
const pay = (amountCents: number, extra: Record<string, unknown> = {}) =>
  recordPaymentSchema.parse({ amountCents, method: "TRANSFER", paidAt: NOW, ...extra });
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);

let seq = 0;
async function mkOrg(opts: { mail?: boolean; email?: string | null; language?: string; builtIn?: boolean } = {}): Promise<BankTestOrg> {
  seq += 1;
  const o = await mkBankOrg(`Zahlungsmail ${seq} GmbH`, ISSUE);
  await saveDocumentSettings(o.orgId, { viesCheckEnabled: false });
  if (opts.mail !== false) {
    await saveMailSettings(o.orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Zahlungsmail GmbH", fromEmail: "rechnung@example.org", copyToSelf: false, defaultCc: "", defaultBcc: "" });
  }
  const email = opts.email === undefined ? "rechnung@kunde.example.org" : opts.email;
  await dbInternal.customer.update({ where: { id: o.customerId }, data: { invoiceEmail: email, ...(opts.language ? { language: opts.language } : {}) }, select: { id: true } });
  if (opts.builtIn) await dbInternal.emailTemplate.deleteMany({ where: { orgId: o.orgId, docType: "PAYMENT_CONFIRMATION" } });
  return o;
}
async function mkRule(orgId: string, templateId: string | null = null, name = "Bestaetigung"): Promise<string> {
  const r = await dbInternal.paymentRule.create({
    data: { orgId, name, trigger: "PAID_FULL", delayMinutes: 0, actionsJson: JSON.stringify([{ type: "SEND_PAYMENT_CONFIRMATION", templateId }]) },
    select: { id: true },
  });
  return r.id;
}
async function mkAnyRule(orgId: string, trigger: "PAID_FULL" | "PAID_PARTIAL", templateId: string | null = null): Promise<string> {
  const r = await dbInternal.paymentRule.create({
    data: { orgId, name: `Regel ${trigger}`, trigger, delayMinutes: 0, actionsJson: JSON.stringify([{ type: "SEND_PAYMENT_CONFIRMATION", templateId }]) },
    select: { id: true },
  });
  return r.id;
}
async function paid(o: BankTestOrg, amount = GROSS, customerId = o.customerId) {
  const inv = await mkInvoice({ ...o, customerId }, ISSUE);
  const p = await recordPayment(inv.id, pay(amount), { orgId: o.orgId, now: NOW });
  return { inv, paymentId: p.recorded.id };
}
const runs = (orgId: string) =>
  dbInternal.paymentRuleRun.findMany({
    where: { orgId }, orderBy: { createdAt: "asc" },
    select: { id: true, status: true, attempts: true, nextAttemptAt: true, stepsJson: true, mailSentAt: true, paymentId: true },
  });
const steps = (json: string): { type: string; status: string; note?: string }[] => JSON.parse(json);
const logsOf = (orgId: string) =>
  dbInternal.emailLog.findMany({ where: { orgId, docType: "PAYMENT_CONFIRMATION" }, orderBy: { createdAt: "asc" }, select: { id: true, docId: true, status: true, subject: true, bodySnapshot: true, toJson: true, warningsJson: true, error: true } });

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  process.env.PAYMENT_RULES_AFTER_COMMIT = "0";
});
afterAll(() => {
  delete process.env.APP_BASE_URL;
});

describe("Versand", () => {
  it("Vollzahlung, eingebauter Text de -> eine Mail an invoiceEmail, Protokoll unter der Zahlung, kein Rechnungsversand", async () => {
    const o = await mkOrg({ builtIn: true });
    await mkRule(o.orgId);
    const { inv, paymentId } = await paid(o);
    const prov = createMemoryProvider();
    const res = await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(res).toMatchObject({ claimed: 1, done: 1 });
    expect(prov.sent).toHaveLength(1);
    const m = prov.sent[0]!;
    expect(m.to).toEqual(["rechnung@kunde.example.org"]);
    expect(m.subject).toContain(inv.number);
    expect(m.text).toContain("119,00");
    expect(m.text).toContain("vollständig bezahlt");
    expect(m.attachments).toEqual([]);

    const logs = await logsOf(o.orgId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ docId: paymentId, status: "SENT" });
    const change = await dbInternal.changeLog.findMany({ where: { orgId: o.orgId, entity: "EMAIL", entityId: logs[0]!.id }, select: { action: true, diffJson: true } });
    expect(change).toHaveLength(1);
    expect(change[0]!.diffJson).toContain(inv.number);
    expect(await dbInternal.activityLog.count({ where: { orgId: o.orgId, entityId: inv.id, type: "PAYMENT_CONFIRMATION_SENT" } })).toBe(1);
    // Kein Rechnungsversand: kein Protokoll an der Rechnung, Rechnung nicht als versendet markiert.
    expect(await dbInternal.emailLog.count({ where: { orgId: o.orgId, docId: inv.id } })).toBe(0);
    const list = await listInvoices(o.orgId, {});
    expect(list.rows.find((r) => r.id === inv.id)).toMatchObject({ hasEmailLog: false, status: "PAID" });
    const [run] = await runs(o.orgId);
    expect(steps(run!.stepsJson)[0]!.status).toBe("DONE");
  });

  it("Status der Rechnung nach Gegenbuchung unveraendert gegenueber einem Lauf ohne Mail", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId);
    const { inv, paymentId } = await paid(o);
    await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: createMemoryProvider() });
    await reversePayment(paymentId, { reason: "Fehlbuchung" }, { actor: "t", orgId: o.orgId, now: at(10) });
    const o2 = await mkOrg({ mail: false });
    const { inv: inv2, paymentId: p2 } = await paid(o2);
    await reversePayment(p2, { reason: "Fehlbuchung" }, { actor: "t", orgId: o2.orgId, now: at(10) });
    const a = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { status: true, paidAmountCents: true } });
    const b = await dbInternal.invoice.findUniqueOrThrow({ where: { id: inv2.id }, select: { status: true, paidAmountCents: true } });
    expect(a).toEqual(b);
  });

  it("Kundensprache en -> englischer Text; Teilzahlung nennt den offenen Rest zum Zahlungszeitpunkt auch nach weiterer Zahlung", async () => {
    const o = await mkOrg({ builtIn: true, language: "en" });
    await mkAnyRule(o.orgId, "PAID_PARTIAL");
    const inv = await mkInvoice(o, ISSUE);
    const p1 = await recordPayment(inv.id, pay(5000), { orgId: o.orgId, now: NOW });
    // Weitere Zahlung kommt, bevor der Lauf ausgefuehrt wird.
    await recordPayment(inv.id, pay(2000), { orgId: o.orgId, now: NOW });
    const prov = createMemoryProvider();
    await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    const first = prov.sent.find((m) => m.text.includes("50.00"));
    expect(first).toBeDefined();
    expect(first!.subject).toMatch(/^Payment received for invoice/);
    expect(first!.text).toContain("thank you");
    expect(first!.text).toContain("69.00");
    expect(first!.text).toContain("still outstanding");
    expect(p1.recorded.id).toBeTruthy();
  });

  it("Standardvorlage DE mit Platzhaltern wird ohne templateId verwendet", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId);
    await paid(o);
    const prov = createMemoryProvider();
    await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(prov.sent[0]!.text).toContain("Zahlung über 119,00");
    expect(prov.sent[0]!.text).toContain("Offener Betrag: 0,00");
  });

  it("eigene Vorlage mit Zahlungsplatzhaltern und Portal-Link: Mail traegt den Link, Protokoll ist geschwaerzt; geloeschte Vorlage -> Standard", async () => {
    const o = await mkOrg();
    process.env.APP_BASE_URL = BASE;
    await savePortalSettings(o.orgId, { enabled: true, mailSubject: null, mailBody: null }, "test");
    const { url } = await createPortalLink(o.orgId, o.customerId, { expiresInDays: 10 }, { actor: "t", baseUrl: BASE });
    const tpl = await dbInternal.emailTemplate.create({
      data: {
        orgId: o.orgId, docType: "PAYMENT_CONFIRMATION", language: "de", name: "Eigene", subject: "Eingang {{paymentReceived.amount}}",
        body: "Danke ({{paymentReceived.method}}): {{portal.url}} {{unbekannt.feld}}", signature: "Gruss {{company.name}}",
      },
      select: { id: true },
    });
    const ruleId = await mkRule(o.orgId, tpl.id);
    await paid(o);
    const prov = createMemoryProvider();
    await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    const m = prov.sent[0]!;
    expect(m.subject).toBe("Eingang 119,00 €");
    expect(m.text).toContain(url);
    expect(m.text).toContain("Ueberweisung");
    expect(m.text).toContain("Gruss Zahlungsmail");
    const [log] = await logsOf(o.orgId);
    expect(log!.bodySnapshot).toContain("[Portal-Link]");
    expect(log!.bodySnapshot).not.toContain(url);
    expect(log!.bodySnapshot).not.toContain("/portal/");
    expect(JSON.parse(log!.warningsJson)).toEqual(["Unbekannter Platzhalter {{unbekannt.feld}}"]);
    const change = await dbInternal.changeLog.findMany({ where: { orgId: o.orgId, entity: "EMAIL" }, select: { diffJson: true } });
    expect(JSON.stringify(change)).not.toContain("/portal/");

    // Vorlage geloescht -> Standardvorlage der Sprache.
    await dbInternal.paymentRule.update({ where: { id: ruleId }, data: { active: false }, select: { id: true } });
    await dbInternal.emailTemplate.delete({ where: { id: tpl.id } });
    const ruleB = await mkRule(o.orgId, tpl.id, "Zweite");
    await paid(o);
    await processPaymentRuleRuns({ orgId: o.orgId, now: at(1), provider: prov });
    expect(prov.sent).toHaveLength(2);
    expect(prov.sent[1]!.subject).toContain("Zahlungseingang zur Rechnung");
    expect(ruleB).toBeTruthy();
    delete process.env.APP_BASE_URL;
  });

  it("zwei Regeln mit Bestaetigung -> eine Mail, zweiter Schritt ALREADY; QUEUED-Vorgaenger -> keine Mail, SKIPPED", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId, null, "Eins");
    await mkRule(o.orgId, null, "Zwei");
    await paid(o);
    const prov = createMemoryProvider();
    await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(prov.sent).toHaveLength(1);
    expect(await logsOf(o.orgId)).toHaveLength(1);
    const rs = await runs(o.orgId);
    expect(rs.map((r) => r.status)).toEqual(["DONE", "DONE"]);
    expect(rs.map((r) => steps(r.stepsJson)[0]!.note ?? "").some((n) => n.startsWith("bereits gesendet"))).toBe(true);

    const o2 = await mkOrg();
    await mkRule(o2.orgId);
    const { paymentId } = await paid(o2);
    await dbInternal.emailLog.create({
      data: { orgId: o2.orgId, docType: "PAYMENT_CONFIRMATION", docId: paymentId, fromEmail: "rechnung@example.org", toJson: "[]", ccJson: "[]", bccJson: "[]", subject: "x", bodySnapshot: "x", status: "QUEUED", sentByUserId: "t" },
      select: { id: true },
    });
    const prov2 = createMemoryProvider();
    await processPaymentRuleRuns({ orgId: o2.orgId, now: NOW, provider: prov2 });
    expect(prov2.sent).toHaveLength(0);
    const [r2] = await runs(o2.orgId);
    expect(steps(r2!.stepsJson)[0]).toMatchObject({ status: "SKIPPED" });
    expect(steps(r2!.stepsJson)[0]!.note).toContain("Versandergebnis unbekannt");
  });

  it("Provider wirft nach der Uebergabe -> genau ein Versandversuch, Lauf FAILED, kein automatischer Folgeversuch", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId);
    await paid(o);
    const prov = createMemoryProvider();
    prov.failNext("SMTP down");
    const r1 = await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(r1).toMatchObject({ claimed: 1, failed: 1, retry: 0 });
    expect((await logsOf(o.orgId))[0]).toMatchObject({ status: "FAILED", error: "SMTP down" });
    const [failed] = await runs(o.orgId);
    expect(failed!.status).toBe("FAILED");
    expect(failed!.mailSentAt).not.toBeNull();
    expect(steps(failed!.stepsJson)[0]).toMatchObject({ status: "FAILED", error: "Versand unklar – E-Mail-Protokoll pruefen" });
    // Spaetere Laeufe fassen den Lauf nicht an; es bleibt bei einem Versandversuch.
    expect(await processPaymentRuleRuns({ orgId: o.orgId, now: at(600), provider: prov })).toMatchObject({ claimed: 0 });
    expect(prov.sent).toHaveLength(0);
    expect(await logsOf(o.orgId)).toHaveLength(1);
  });

  it("Fehler vor dem Senden (keine Mail-Einstellungen) -> Claim frei, Folgeversuch sendet genau einmal", async () => {
    const o = await mkOrg({ mail: false });
    await mkRule(o.orgId);
    await paid(o);
    const prov = createMemoryProvider();
    const r1 = await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(r1).toMatchObject({ claimed: 1, retry: 1 });
    const [pending] = await runs(o.orgId);
    expect(pending!.status).toBe("PENDING");
    expect(pending!.mailSentAt).toBeNull();
    expect(prov.sent).toHaveLength(0);
    await saveMailSettings(o.orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Zahlungsmail GmbH", fromEmail: "rechnung@example.org", copyToSelf: false, defaultCc: "", defaultBcc: "" });
    const r2 = await processPaymentRuleRuns({ orgId: o.orgId, now: at(10), provider: prov });
    expect(r2).toMatchObject({ claimed: 1, done: 1 });
    expect(prov.sent).toHaveLength(1);
    expect((await logsOf(o.orgId)).map((l) => l.status)).toEqual(["SENT"]);
  });

  it("manueller Retry nach unklarem Versand gibt den Claim frei (Folgeversand)", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId);
    await paid(o);
    const prov = createMemoryProvider();
    prov.failNext("SMTP down");
    await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    const [failed] = await runs(o.orgId);
    await retryPaymentRuleRun(o.orgId, failed!.id, "tester");
    const [pending] = await runs(o.orgId);
    expect(pending).toMatchObject({ status: "PENDING", mailSentAt: null });
    const r = await processPaymentRuleRuns({ orgId: o.orgId, now: at(600), provider: prov });
    expect(r).toMatchObject({ claimed: 1, done: 1 });
    expect(prov.sent).toHaveLength(1);
  });

  it("interne Notiz der Rechnung erscheint nicht in der Mail; Kunde ohne Mailadresse -> Schritt SKIPPED, Lauf DONE", async () => {
    const o = await mkOrg({ builtIn: true });
    await mkRule(o.orgId);
    const { inv } = await paid(o);
    await dbInternal.invoice.update({ where: { id: inv.id }, data: { internalNotes: "GEHEIM-NOTIZ-4711" }, select: { id: true } });
    const prov = createMemoryProvider();
    await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(JSON.stringify(prov.sent)).not.toContain("GEHEIM-NOTIZ-4711");
    expect(JSON.stringify(await logsOf(o.orgId))).not.toContain("GEHEIM-NOTIZ-4711");

    const o2 = await mkOrg({ email: null });
    await mkRule(o2.orgId);
    await paid(o2);
    const prov2 = createMemoryProvider();
    await processPaymentRuleRuns({ orgId: o2.orgId, now: NOW, provider: prov2 });
    expect(prov2.sent).toHaveLength(0);
    const [run] = await runs(o2.orgId);
    expect(run!.status).toBe("DONE");
    expect(steps(run!.stepsJson)[0]).toMatchObject({ status: "SKIPPED", note: "Kunde ohne E-Mail-Adresse" });
    expect(run!.mailSentAt).toBeNull();
  });
});

describe("Versandgrenzen", () => {
  it("6 Zahlungen desselben Kunden -> 5 Mails, 6. Lauf PENDING mit Termin ca. 1 Stunde, Versuche unveraendert; danach Versand", async () => {
    const o = await mkOrg();
    await mkRule(o.orgId);
    for (let i = 0; i < CONFIRMATION_MAX_PER_CUSTOMER_HOUR + 1; i += 1) await paid(o);
    const prov = createMemoryProvider();
    const res = await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(res).toMatchObject({ claimed: 6, done: 5, deferred: 1 });
    expect(prov.sent).toHaveLength(5);
    const rs = await runs(o.orgId);
    const deferred = rs.filter((r) => r.status === "PENDING");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.attempts).toBe(0);
    expect(deferred[0]!.nextAttemptAt.getTime()).toBe(NOW.getTime() + 60 * 60_000);
    expect(deferred[0]!.mailSentAt).toBeNull();
    expect(steps(deferred[0]!.stepsJson)[0]).toMatchObject({ status: "PENDING", note: "Versandgrenze je Kunde erreicht" });

    // Zu frueh: nicht faellig; nach einer Stunde: gesendet.
    expect(await processPaymentRuleRuns({ orgId: o.orgId, now: at(59), provider: prov })).toMatchObject({ claimed: 0 });
    expect(await processPaymentRuleRuns({ orgId: o.orgId, now: at(60), provider: prov })).toMatchObject({ claimed: 1, done: 1 });
    expect(prov.sent).toHaveLength(6);
  });

  it("Grenze je Firma: bei 100 Versendungen in der Stunde wird verschoben", async () => {
    const o = await mkOrg();
    const ruleId = await mkRule(o.orgId);
    await paid(o);
    const rule = await dbInternal.paymentRule.findUniqueOrThrow({ where: { id: ruleId }, select: { id: true } });
    for (let i = 0; i < CONFIRMATION_MAX_PER_ORG_HOUR; i += 1) {
      const other = await dbInternal.customer.create({ data: { orgId: o.orgId, name: `Kunde ${i}`, addressLine1: "Weg 1", postalCode: "20095", city: "Hamburg" }, select: { id: true } });
      await dbInternal.paymentRuleRun.create({
        data: {
          orgId: o.orgId, ruleId: rule.id, paymentId: `fremd-${seq}-${i}`, invoiceId: `inv-${i}`, customerId: other.id, trigger: "PAID_FULL", source: "MANUAL",
          actionsJson: "[]", stepsJson: "[]", contextJson: "{}", status: "DONE", nextAttemptAt: NOW, mailSentAt: at(-30),
        },
        select: { id: true },
      });
    }
    const prov = createMemoryProvider();
    const res = await processPaymentRuleRuns({ orgId: o.orgId, now: NOW, provider: prov });
    expect(res).toMatchObject({ claimed: 1, deferred: 1 });
    expect(prov.sent).toHaveLength(0);
    const pending = (await runs(o.orgId)).find((r) => r.status === "PENDING")!;
    expect(pending.nextAttemptAt.getTime()).toBe(at(-30).getTime() + 60 * 60_000);
    expect(steps(pending.stepsJson)[0]!.note).toBe("Versandgrenze je Firma erreicht");
  });
});

describe("Schema und Vorlagen", () => {
  it("Vorlagenschema akzeptiert PAYMENT_CONFIRMATION, generischer Versand lehnt ihn ab", () => {
    expect(emailTemplateInputSchema.safeParse({ name: "x", docType: "PAYMENT_CONFIRMATION", subject: "s", body: "b" }).success).toBe(true);
    const send = sendEmailInputSchema.safeParse({ docType: "PAYMENT_CONFIRMATION", docId: "x", to: "a@example.org", subject: "s", body: "b" });
    expect(send.success).toBe(false);
    expect(EMAIL_TEMPLATE_DOC_TYPES).toContain("PAYMENT_CONFIRMATION");
  });

  it("Beispielkontext enthaelt paymentReceived; Standardvorlagen de/en vorhanden und nutzen nur bekannte Platzhalter", () => {
    const ctx = sampleTemplateContext("PAYMENT_CONFIRMATION");
    expect(ctx.paymentReceived).toMatchObject({ amount: expect.any(String), date: expect.any(String), openAmount: expect.any(String), method: expect.any(String) });
    for (const set of [DEFAULT_EMAIL_TEMPLATES, DEFAULT_EMAIL_TEMPLATES_EN]) {
      const t = set.find((x) => x.docType === "PAYMENT_CONFIRMATION");
      expect(t).toBeDefined();
      expect(`${t!.subject}${t!.body}`).not.toMatch(/internalNotes|\{\{offer|\{\{dunning/);
    }
  });
});
