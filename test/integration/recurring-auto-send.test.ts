/**
 * Automatischer Versand von Abo-Rechnungen mit Wiederholung (Outbox InvoiceAutoSend):
 * nie Doppelversand, manueller Versand stoppt die Automatik, unklarer Ausgang wird nicht wiederholt.
 * Eigenes Jahr 2275 (Invoice.number global eindeutig), eigene Organisation, Memory-Provider, kein Netz.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBestandRecurring } from "../helpers/recurring-bestand";
import { dbInternal } from "@/lib/db";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveMailSettings } from "@/domain/email/settings";
import { prefillEmail } from "@/domain/email/compose";
import { sendDocumentEmail } from "@/domain/email/send";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createMemoryProvider } from "@/lib/mail/memory";
import type { MailProvider } from "@/lib/mail/provider";
import { AutoSendRunningError } from "@/domain/recurring/auto-send-guard";
import { runDueRecurring } from "@/domain/recurring/run";
import { dispatchAutoSend, retryAutoSend, runAutoSendJob, AutoSendRetryError } from "@/domain/recurring/auto-send";
import { createRecurringSchema } from "@/schemas";

const START = "2275-03-01T10:00:00.000Z";
const MIN = 60_000;
let orgId: string;
let seq = 0;

beforeAll(async () => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-auth-secret-mindestens-16-zeichen";
  const org = await dbInternal.organization.create({
    data: { legalName: "Auto Versand GmbH", addressLine1: "Weg 5", postalCode: "99905", city: "Teststadt", vatId: "DE123456789", taxNumber: "33/123/45678" },
    select: { id: true },
  });
  orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveMailSettings(orgId, { host: "localhost", port: 2525, security: "NONE", fromName: "Auto Versand GmbH", fromEmail: "rechnung@example.org", defaultCc: "", defaultBcc: "", copyToSelf: false });
});

// Jeder Test sieht nur seine eigenen Auftraege (der Job arbeitet ohne Org-Filter).
beforeEach(async () => {
  await dbInternal.invoiceAutoSend.updateMany({ where: { status: { in: ["PENDING", "RETRY", "NO_ADDRESS", "SENDING", "MANUAL_PENDING"] } }, data: { status: "DONE_MANUAL" } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function customer(email: string | null): Promise<string> {
  seq += 1;
  const c = await dbInternal.customer.create({
    data: { orgId, name: `Versandkunde ${seq}`, addressLine1: "Kundenweg 5", postalCode: "99905", city: "Teststadt", countryCode: "DE", type: "BUSINESS", ...(email ? { email } : {}) },
    select: { id: true },
  });
  return c.id;
}

const item = (cents: number) => ({ lineType: "ITEM", description: "Leistung", quantityMilli: 1000, unit: "C62", unitNetPriceCents: cents, taxRate: 19, taxCategory: "S", discountPermille: 0, discountCents: 0 });

async function abo(customerId: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return createBestandRecurring(
    orgId,
    createRecurringSchema.parse({ customerId, title: `Abo ${seq}`, startDate: START, autoFinalize: true, autoSend: true, lines: [item(1000)], ...extra }),
  );
}

/** Laeuft das Abo einmal und liefert die Rechnung samt Zeile. */
async function emit(customerId: string, provider: ReturnType<typeof createMemoryProvider>, extra: Record<string, unknown> = {}) {
  const rec = await abo(customerId, extra);
  const now = rec.nextRunDate;
  const summaries = await runDueRecurring({ now, orgId, provider });
  const emitted = summaries.flatMap((s) => s.emitted).filter((e) => e.invoiceId);
  const first = emitted[0]!;
  const row = await dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { invoiceId: first.invoiceId } });
  return { rec, now, out: first, row, emitted };
}

const rowOf = (invoiceId: string) => dbInternal.invoiceAutoSend.findUniqueOrThrow({ where: { invoiceId } });
const notifications = (invoiceId: string) => dbInternal.notification.count({ where: { orgId, type: "RECURRING_NOT_SENT", entityId: invoiceId } });
const later = (d: Date, ms: number) => new Date(d.getTime() + ms);

describe("automatischer Versand", () => {
  it("1: Kunde mit Mail -> genau 1 Mail, Zeile SENT mit emailLogId, keine Benachrichtigung", async () => {
    const provider = createMemoryProvider();
    const { out, row } = await emit(await customer("auto1@example.org"), provider);
    expect(out.emailStatus).toBe("SENT");
    expect(provider.sent).toHaveLength(1);
    expect(row.status).toBe("SENT");
    expect(row.emailLogId).toBeTruthy();
    expect(row.attempts).toBe(1);
    expect(await notifications(out.invoiceId)).toBe(0);
  });

  it("2: Kunde ohne Mail -> NO_ADDRESS, genau 1 Benachrichtigung (auch bei abgewaehltem Typ); Adresse nachgetragen -> 1 Mail", async () => {
    await dbInternal.notificationSettings.upsert({ where: { orgId }, create: { orgId, enabledTypesJson: "[]" }, update: { enabledTypesJson: "[]" } });
    const provider = createMemoryProvider();
    const cid = await customer(null);
    const { out, now, row } = await emit(cid, provider);
    expect(out.emailStatus).toBe("SKIPPED");
    expect(row.status).toBe("NO_ADDRESS");
    expect(row.attempts).toBe(0);
    expect(await notifications(out.invoiceId)).toBe(1);
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: out.invoiceId, type: "AUTO_SEND_PROBLEM" } })).toBe(1);

    // Vor Ablauf der 6 Stunden: nichts faellig.
    expect((await runAutoSendJob(later(now, 60 * MIN), provider)).checked).toBe(0);
    // Nach 6 Stunden: noch keine Adresse -> bleibt, keine zweite Benachrichtigung.
    await runAutoSendJob(later(now, 6 * 60 * MIN), provider);
    expect((await rowOf(out.invoiceId)).status).toBe("NO_ADDRESS");
    expect(await notifications(out.invoiceId)).toBe(1);
    expect(provider.sent).toHaveLength(0);

    await dbInternal.customer.update({ where: { id: cid }, data: { invoiceEmail: "nachtrag@example.org" } });
    await runAutoSendJob(later(now, 13 * 60 * MIN), provider);
    expect((await rowOf(out.invoiceId)).status).toBe("SENT");
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toEqual(["nachtrag@example.org"]);
  });

  it("2b: ohne Adresse nach 7 Tagen -> GAVE_UP mit Benachrichtigung", async () => {
    const provider = createMemoryProvider();
    const { out, now } = await emit(await customer(null), provider);
    await runAutoSendJob(later(now, 7 * 24 * 60 * MIN + 6 * 60 * MIN), provider);
    const row = await rowOf(out.invoiceId);
    expect(row.status).toBe("GAVE_UP");
    expect(row.lastError).toBe("NO_ADDRESS");
    expect(await notifications(out.invoiceId)).toBe(2);
  });

  it("3: sicher nicht angenommen -> RETRY, vor der Zeit kein Versuch, danach genau 1 Mail", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, now, row } = await emit(await customer("auto3@example.org"), provider);
    expect(out.emailStatus).toBe("FAILED");
    expect(row.status).toBe("RETRY");
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + 15 * MIN);
    await runAutoSendJob(later(now, 5 * MIN), provider);
    expect((await rowOf(out.invoiceId)).attempts).toBe(1);
    expect(provider.sent).toHaveLength(0);
    await runAutoSendJob(later(now, 16 * MIN), provider);
    const after = await rowOf(out.invoiceId);
    expect(after.status).toBe("SENT");
    expect(after.attempts).toBe(2);
    expect(provider.sent).toHaveLength(1);
    expect(await notifications(out.invoiceId)).toBe(0);
  });

  it("3b: viermal sicher nicht angenommen -> GAVE_UP mit Benachrichtigung", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, now } = await emit(await customer("auto3b@example.org"), provider);
    let t = now;
    for (let i = 0; i < 3; i++) {
      t = later(t, 5 * 60 * MIN);
      provider.failNext("x", "NOT_SENT");
      await runAutoSendJob(t, provider);
    }
    const row = await rowOf(out.invoiceId);
    expect(row.status).toBe("GAVE_UP");
    expect(row.lastError).toBe("SMTP_REJECTED");
    expect(row.attempts).toBe(4);
    expect(provider.sent).toHaveLength(0);
    expect(await notifications(out.invoiceId)).toBe(1);
  });

  it("4: unklarer Ausgang -> UNCLEAR mit Benachrichtigung, weitere Laeufe senden nichts", async () => {
    const provider = createMemoryProvider();
    provider.failNext("timeout", "UNKNOWN");
    const { out, now, row } = await emit(await customer("auto4@example.org"), provider);
    expect(out.emailStatus).toBe("UNCLEAR");
    expect(row.status).toBe("UNCLEAR");
    expect(await notifications(out.invoiceId)).toBe(1);
    await runAutoSendJob(later(now, 48 * 60 * MIN), provider);
    await runAutoSendJob(later(now, 96 * 60 * MIN), provider);
    expect((await rowOf(out.invoiceId)).status).toBe("UNCLEAR");
    expect(provider.sent).toHaveLength(0);
  });

  it("5: manuell versendet waehrend RETRY -> DONE_MANUAL, keine zweite Mail", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, now } = await emit(await customer("auto5@example.org"), provider);
    const manualProvider = createMemoryProvider();
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: out.invoiceId });
    const res = await sendDocumentEmail(orgId, "user-1", {
      docType: "INVOICE", docId: out.invoiceId, to: pre.to.join(","), cc: "", bcc: "", subject: pre.subject, body: pre.body, signature: pre.signature,
      copyToSelf: false, standardAttachments: pre.defaultStandardAttachments, templateId: pre.templateId, warnings: [],
    }, [], manualProvider);
    expect(res.status).toBe("SENT");
    await runAutoSendJob(later(now, 20 * MIN), provider);
    expect((await rowOf(out.invoiceId)).status).toBe("DONE_MANUAL");
    expect(provider.sent).toHaveLength(0);
    expect(manualProvider.sent).toHaveLength(1);
  });

  it("6: Absturz waehrend SENDING: ohne Protokoll -> RETRY und 1 Mail; mit QUEUED-Protokoll -> UNCLEAR ohne Mail", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const a = await emit(await customer("auto6a@example.org"), provider);
    const claimed = later(a.now, 60 * MIN);
    await dbInternal.invoiceAutoSend.update({ where: { id: a.row.id }, data: { status: "SENDING", claimedAt: later(claimed, -31 * MIN) } });
    await runAutoSendJob(claimed, provider);
    expect((await rowOf(a.out.invoiceId)).status).toBe("SENT");
    expect(provider.sent).toHaveLength(1);

    const provider2 = createMemoryProvider();
    provider2.failNext("x", "NOT_SENT");
    const b = await emit(await customer("auto6b@example.org"), provider2);
    const claimedB = later(b.now, 60 * MIN);
    await dbInternal.invoiceAutoSend.update({ where: { id: b.row.id }, data: { status: "SENDING", claimedAt: later(claimedB, -31 * MIN) } });
    await dbInternal.emailLog.create({
      data: { orgId, docType: "INVOICE", docId: b.out.invoiceId, subject: "s", bodySnapshot: "b", status: "QUEUED", sentByUserId: "recurring-runner", createdAt: later(claimedB, -30 * MIN) },
    });
    await runAutoSendJob(claimedB, provider2);
    expect((await rowOf(b.out.invoiceId)).status).toBe("UNCLEAR");
    expect(provider2.sent).toHaveLength(0);
  });

  it("7: zwei parallele dispatchAutoSend -> genau 1 Mail", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { row, now } = await emit(await customer("auto7@example.org"), provider);
    const at = later(now, 20 * MIN);
    const res = await Promise.all([dispatchAutoSend(row.id, at, provider), dispatchAutoSend(row.id, at, provider)]);
    expect(provider.sent).toHaveLength(1);
    expect(res.map((r) => r.status).sort()).toEqual(["NOT_CLAIMED", "SENT"]);
  });

  it("8: Rechnung vor dem Wiederholungsversuch storniert -> CANCELLED, keine Mail", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, now } = await emit(await customer("auto8@example.org"), provider);
    await cancelInvoice(out.invoiceId, { orgId, actor: "tester", now, reason: "Test" });
    await runAutoSendJob(later(now, 20 * MIN), provider);
    expect((await rowOf(out.invoiceId)).status).toBe("CANCELLED");
    expect(provider.sent).toHaveLength(0);
  });

  it("9: Sammelrechnung mit autoSend -> 1 Zeile, 1 Mail", async () => {
    const provider = createMemoryProvider();
    const cid = await customer("auto9@example.org");
    await abo(cid, { collectiveBilling: true, invoiceHeading: "Block A" });
    const { emitted, rec } = await emit(cid, provider, { collectiveBilling: true, invoiceHeading: "Block B" });
    const collective = emitted.find((e) => e.collectiveRecurringIds);
    expect(collective).toBeTruthy();
    expect(collective!.emailStatus).toBe("SENT");
    expect(provider.sent).toHaveLength(1);
    expect(await dbInternal.invoiceAutoSend.count({ where: { orgId, invoiceId: collective!.invoiceId } })).toBe(1);
    expect(rec.id).toBeTruthy();
  });

  it("10: retryAutoSend: UNCLEAR ohne Bestaetigung -> Fehler, mit -> 1 Mail, auf SENT -> Fehler", async () => {
    const provider = createMemoryProvider();
    provider.failNext("timeout", "UNKNOWN");
    const { out, now } = await emit(await customer("auto10@example.org"), provider);
    await expect(retryAutoSend(orgId, out.invoiceId, "user-1", { confirmUnclear: false }, later(now, 10 * MIN), provider)).rejects.toBeInstanceOf(AutoSendRetryError);
    expect(provider.sent).toHaveLength(0);
    const status = await retryAutoSend(orgId, out.invoiceId, "user-1", { confirmUnclear: true }, later(now, 10 * MIN), provider);
    expect(status).toBe("SENT");
    expect(provider.sent).toHaveLength(1);
    await expect(retryAutoSend(orgId, out.invoiceId, "user-1", { confirmUnclear: true }, later(now, 20 * MIN), provider)).rejects.toBeInstanceOf(AutoSendRetryError);
    expect(provider.sent).toHaveLength(1);
  });

  it("11: Rechnung wird nie geaendert: festgeschrieben bleibt auch nach Versandfehlern", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, now } = await emit(await customer("auto11@example.org"), provider);
    const before = await dbInternal.invoice.findUniqueOrThrow({ where: { id: out.invoiceId }, select: { status: true, number: true, grossTotalCents: true } });
    await runAutoSendJob(later(now, 20 * MIN), provider);
    const after = await dbInternal.invoice.findUniqueOrThrow({ where: { id: out.invoiceId }, select: { status: true, number: true, grossTotalCents: true } });
    expect(after).toEqual(before);
    expect(after.number).toBeTruthy();
  });

  it("12: Bestandsrechnung ohne Zeile wird vom Job nie versendet und bekommt keine Zeile (R22c-6)", async () => {
    const provider = createMemoryProvider();
    const { out, now, row } = await emit(await customer("auto12@example.org"), provider);
    expect(provider.sent).toHaveLength(1);
    await dbInternal.invoiceAutoSend.delete({ where: { id: row.id } });
    await runAutoSendJob(later(now, 48 * 60 * MIN), provider);
    expect(provider.sent).toHaveLength(1); // keine zweite Mail aus dem Job
    expect(await dbInternal.invoiceAutoSend.count({ where: { invoiceId: out.invoiceId } })).toBe(0);
  });

  it("13: haengende Zeile mit SENT-Protokoll -> SENT ohne zweite Mail", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, now, row } = await emit(await customer("auto13@example.org"), provider);
    const claimed = later(now, 60 * MIN);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { status: "SENDING", claimToken: "alt", claimedAt: later(claimed, -31 * MIN) } });
    const log = await dbInternal.emailLog.create({
      data: { orgId, docType: "INVOICE", docId: out.invoiceId, subject: "s", bodySnapshot: "b", status: "SENT", sentByUserId: "recurring-runner", createdAt: later(claimed, -30 * MIN) },
    });
    await runAutoSendJob(claimed, provider);
    const after = await rowOf(out.invoiceId);
    expect(after.status).toBe("SENT");
    expect(after.emailLogId).toBe(log.id);
    expect(after.claimToken).toBeNull();
    expect(provider.sent).toHaveLength(0);
  });

  it("14: zwei parallele Job-Laeufe -> genau 1 Mail", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, row } = await emit(await customer("auto14@example.org"), provider);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { nextAttemptAt: new Date("2000-01-01T00:00:00.000Z") } });
    await Promise.all([runAutoSendJob(new Date(), provider), runAutoSendJob(new Date(), provider)]);
    expect(provider.sent).toHaveLength(1);
    expect((await rowOf(out.invoiceId)).status).toBe("SENT");
  });

  it("15: Claim ueberholt waehrend des Versands -> der alte Lauf aendert die Zeile nicht und meldet nichts", async () => {
    const inner = createMemoryProvider();
    inner.failNext("x", "NOT_SENT");
    const { out, row } = await emit(await customer("auto15@example.org"), inner);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { nextAttemptAt: new Date("2000-01-01T00:00:00.000Z") } });
    const overtaking: MailProvider = {
      async send(mail) {
        // ein anderer Lauf loest die Zeile als haengend auf (Token weg, Status RETRY)
        await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { status: "RETRY", claimToken: null, attempts: 7, lastError: "PREPARE_FAILED" } });
        return inner.send(mail);
      },
    };
    const res = await dispatchAutoSend(row.id, new Date(), overtaking);
    expect(res.status).toBe("RETRY");
    const after = await rowOf(out.invoiceId);
    expect(after.status).toBe("RETRY");
    expect(after.attempts).toBe(7);
    expect(after.lastError).toBe("PREPARE_FAILED");
  });

  it("16: QUEUED-Protokoll eines manuellen Versands -> UNCLEAR; bestaetigter Neustart sendet trotzdem und meldet erneut", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, now, row } = await emit(await customer("auto16@example.org"), provider);
    await dbInternal.emailLog.create({
      data: { orgId, docType: "INVOICE", docId: out.invoiceId, subject: "s", bodySnapshot: "b", status: "QUEUED", sentByUserId: "user-1" },
    });
    await runAutoSendJob(later(now, 20 * MIN), provider);
    expect((await rowOf(out.invoiceId)).status).toBe("UNCLEAR");
    expect(await notifications(out.invoiceId)).toBe(1);
    expect(provider.sent).toHaveLength(0);
    const status = await retryAutoSend(orgId, out.invoiceId, "user-1", { confirmUnclear: true }, later(now, 30 * MIN), provider);
    expect(status).toBe("SENT");
    expect(provider.sent).toHaveLength(1);
    expect(row.id).toBeTruthy();
  });

  it("17: nach Neustart meldet ein zweites UNCLEAR erneut (Schluessel je Zyklus)", async () => {
    const provider = createMemoryProvider();
    provider.failNext("timeout", "UNKNOWN");
    const { out, now } = await emit(await customer("auto17@example.org"), provider);
    expect(await notifications(out.invoiceId)).toBe(1);
    provider.failNext("timeout", "UNKNOWN");
    const status = await retryAutoSend(orgId, out.invoiceId, "user-1", { confirmUnclear: true }, later(now, 10 * MIN), provider);
    expect(status).toBe("UNCLEAR");
    expect(await notifications(out.invoiceId)).toBe(2);
    expect((await rowOf(out.invoiceId)).notifiedStatus).toBe("UNCLEAR");
  });

  it("18: Statuswechsel und Benachrichtigung gemeinsam; verpasste Meldung holt der Job nach (einmal)", async () => {
    const provider = createMemoryProvider();
    provider.failNext("timeout", "UNKNOWN");
    const { out, now, row } = await emit(await customer("auto18@example.org"), provider);
    expect((await rowOf(out.invoiceId)).notifiedStatus).toBe("UNCLEAR");
    // Absturz zwischen Statuswechsel und Meldung nachgestellt: Meldung und Merker weg.
    await dbInternal.notification.deleteMany({ where: { orgId, entityId: out.invoiceId, type: "RECURRING_NOT_SENT" } });
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { notifiedStatus: null } });
    await runAutoSendJob(later(now, 60 * MIN), provider);
    await runAutoSendJob(later(now, 120 * MIN), provider);
    expect(await notifications(out.invoiceId)).toBe(1);
    expect((await rowOf(out.invoiceId)).notifiedStatus).toBe("UNCLEAR");
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: out.invoiceId, type: "AUTO_SEND_PROBLEM" } })).toBe(2);
  });

  it("19: manueller Versand wird abgelehnt, solange die Automatik sendet (SENDING)", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, row } = await emit(await customer("auto19@example.org"), provider);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { status: "SENDING", claimToken: "t", claimedAt: new Date() } });
    const manualProvider = createMemoryProvider();
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: out.invoiceId });
    await expect(
      sendDocumentEmail(orgId, "user-1", {
        docType: "INVOICE", docId: out.invoiceId, to: pre.to.join(","), cc: "", bcc: "", subject: pre.subject, body: pre.body, signature: pre.signature,
        copyToSelf: false, standardAttachments: pre.defaultStandardAttachments, templateId: pre.templateId, warnings: [],
      }, [], manualProvider),
    ).rejects.toBeInstanceOf(AutoSendRunningError);
    expect(manualProvider.sent).toHaveLength(0);
  });

  async function manualSend(invoiceId: string, provider: MailProvider) {
    const pre = await prefillEmail(orgId, { docType: "INVOICE", docId: invoiceId });
    return sendDocumentEmail(orgId, "user-1", {
      docType: "INVOICE", docId: invoiceId, to: pre.to.join(","), cc: "", bcc: "", subject: pre.subject, body: pre.body, signature: pre.signature,
      copyToSelf: false, standardAttachments: pre.defaultStandardAttachments, templateId: pre.templateId, warnings: [],
    }, [], provider);
  }

  it("20: Besitz vor dem Versand verloren -> kein Versand (NOT_CLAIMED), Zeile unveraendert", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, row } = await emit(await customer("auto20@example.org"), provider);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { nextAttemptAt: new Date("2000-01-01T00:00:00.000Z") } });
    const original = dbInternal.emailLog.findMany.bind(dbInternal.emailLog);
    // Zwischen Claim und Besitzpruefung uebernimmt ein anderer Lauf (Token weg, RETRY).
    vi.spyOn(dbInternal.emailLog, "findMany").mockImplementationOnce(((args: unknown) => {
      return dbInternal.invoiceAutoSend
        .update({ where: { id: row.id }, data: { status: "RETRY", claimToken: null }, select: { id: true } })
        .then(() => (original as (a: unknown) => unknown)(args));
    }) as never);
    const sentBefore = provider.sent.length;
    const res = await dispatchAutoSend(row.id, new Date(), provider);
    expect(res.status).toBe("NOT_CLAIMED");
    expect(provider.sent.length).toBe(sentBefore);
    expect((await rowOf(out.invoiceId)).status).toBe("RETRY");
  });

  it("21: haengende Zeile, deren Lauf inzwischen erneuert hat -> wird nicht aufgeloest", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, row } = await emit(await customer("auto21@example.org"), provider);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { status: "SENDING", claimToken: "tok", claimedAt: new Date(Date.now() - 3 * 60 * MIN) } });
    const original = dbInternal.emailLog.findMany.bind(dbInternal.emailLog);
    vi.spyOn(dbInternal.emailLog, "findMany").mockImplementationOnce(((args: unknown) => {
      return dbInternal.invoiceAutoSend
        .update({ where: { id: row.id }, data: { claimedAt: new Date() }, select: { id: true } })
        .then(() => (original as (a: unknown) => unknown)(args));
    }) as never);
    await runAutoSendJob(new Date(), provider);
    const after = await rowOf(out.invoiceId);
    expect(after.status).toBe("SENDING");
    expect(after.claimToken).toBe("tok");
  });

  it("22: manueller Versand sperrt die Zeile atomar: Automatik claimt nicht, danach DONE_MANUAL; bei Fehlschlag zurueck auf RETRY", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, row, now } = await emit(await customer("auto22@example.org"), provider);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { nextAttemptAt: new Date("2000-01-01T00:00:00.000Z") } });
    // Fehlschlag: waehrend des manuellen Versands ist die Zeile gesperrt, die Automatik sendet nichts
    const inner = createMemoryProvider();
    inner.failNext("x", "NOT_SENT");
    let duringStatus = "";
    let duringAuto = "";
    const spying: MailProvider = {
      async send(mail) {
        duringStatus = (await rowOf(out.invoiceId)).status;
        duringAuto = (await dispatchAutoSend(row.id, new Date(), provider)).status;
        return inner.send(mail);
      },
    };
    const failed = await manualSend(out.invoiceId, spying);
    expect(failed.status).toBe("FAILED");
    expect(duringStatus).toBe("MANUAL_PENDING");
    expect(duringAuto).toBe("NOT_CLAIMED");
    expect((await rowOf(out.invoiceId)).status).toBe("RETRY");
    // Erfolg: danach DONE_MANUAL, Automatik sendet nie mehr
    const ok = await manualSend(out.invoiceId, createMemoryProvider());
    expect(ok.status).toBe("SENT");
    expect((await rowOf(out.invoiceId)).status).toBe("DONE_MANUAL");
    const sentBefore = provider.sent.length;
    await runAutoSendJob(later(now, 30 * MIN), provider);
    expect(provider.sent.length).toBe(sentBefore);
  });

  it("22b: abgestuerzter manueller Versand (MANUAL_PENDING) wird nach 30 min anhand des Protokolls aufgeloest", async () => {
    const provider = createMemoryProvider();
    provider.failNext("x", "NOT_SENT");
    const { out, row } = await emit(await customer("auto22b@example.org"), provider);
    await dbInternal.invoiceAutoSend.update({ where: { id: row.id }, data: { status: "MANUAL_PENDING" } });
    await dbInternal.emailLog.create({ data: { orgId, docType: "INVOICE", docId: out.invoiceId, subject: "s", bodySnapshot: "b", status: "QUEUED", sentByUserId: "user-1" } });
    await runAutoSendJob(new Date(Date.now() + 60 * MIN), provider);
    expect((await rowOf(out.invoiceId)).status).toBe("UNCLEAR");
    expect(await notifications(out.invoiceId)).toBe(1);
  });

  it("23: Sweep meldet nur ungemeldete Zeilen (bereits gemeldete terminale Zeilen bleiben unangetastet)", async () => {
    const provider = createMemoryProvider();
    provider.failNext("timeout", "UNKNOWN");
    const a = await emit(await customer("auto23a@example.org"), provider);
    provider.failNext("timeout", "UNKNOWN");
    const b = await emit(await customer("auto23b@example.org"), provider);
    await dbInternal.notification.deleteMany({ where: { orgId, entityId: b.out.invoiceId, type: "RECURRING_NOT_SENT" } });
    await dbInternal.invoiceAutoSend.update({ where: { id: b.row.id }, data: { notifiedStatus: null } });
    const activitiesA = await dbInternal.activityLog.count({ where: { orgId, entityId: a.out.invoiceId, type: "AUTO_SEND_PROBLEM" } });
    await runAutoSendJob(later(b.now, 60 * MIN), provider);
    expect(await notifications(b.out.invoiceId)).toBe(1);
    expect(await notifications(a.out.invoiceId)).toBe(1);
    expect(await dbInternal.activityLog.count({ where: { orgId, entityId: a.out.invoiceId, type: "AUTO_SEND_PROBLEM" } })).toBe(activitiesA);
  });

  it("24: confirmUnclear wird nach dem bestaetigten Versuch zurueckgesetzt", async () => {
    const provider = createMemoryProvider();
    provider.failNext("timeout", "UNKNOWN");
    const { out, now } = await emit(await customer("auto24@example.org"), provider);
    expect((await rowOf(out.invoiceId)).confirmUnclear).toBe(false);
    const status = await retryAutoSend(orgId, out.invoiceId, "user-1", { confirmUnclear: true }, later(now, 10 * MIN), provider);
    expect(status).toBe("SENT");
    expect((await rowOf(out.invoiceId)).confirmUnclear).toBe(false);
  });
});
