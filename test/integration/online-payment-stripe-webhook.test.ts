/**
 * Online-Zahlung (Stripe): signierte Benachrichtigungen, Buchung, Erstattung, Streitfall (Fake-Transport, nie Netz).
 * Testjahr 2222, je Test eigene Organisation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE, PAYMENT_WEBHOOK_SECRET_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { handleProviderWebhook } from "@/domain/online-payment/webhook";
import { refreshAttempt } from "@/domain/online-payment/reconcile";
import { onlinePaymentCancelIdle, setOnlinePaymentTransportOverride } from "@/domain/online-payment/cancel-open";
import { createPaymentRule } from "@/domain/payment-rule/rules";
import { createWebhookEndpoint } from "@/domain/webhook/endpoints";
import { providerPayoutHint, suggestMatches } from "@/domain/bank/match";
import { createInvoiceSchema } from "@/schemas";
import {
  FAKE_STRIPE_LIVE_KEY,
  FAKE_STRIPE_SIGNING_SECRET,
  FAKE_STRIPE_TEST_KEY,
  createStripeFake,
  signStripeEvent,
  stripeFixture,
} from "../helpers/stripe-fake";

const NOW = new Date("2222-03-10T10:00:00.000Z");
const T = Math.floor(NOW.getTime() / 1000);
const BASE = "https://rechnung.example.org";
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;
let counter = 0;

beforeAll(() => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = BASE;
});
afterAll(() => {
  setOnlinePaymentTransportOverride(null);
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});
afterEach(async () => {
  await onlinePaymentCancelIdle();
  setOnlinePaymentTransportOverride(null);
  vi.restoreAllMocks();
});

async function setup(name: string, opts: { mode?: "TEST" | "LIVE"; noSecret?: boolean } = {}) {
  const mode = opts.mode ?? "LIVE";
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  for (const [docType, prefix] of [["INVOICE", "OS22"], ["CREDIT_NOTE", "OT22"]] as const) {
    const p = `${prefix}-${orgId.slice(-6)}-`;
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType, year: 2222 } },
      create: { orgId, docType, year: 2222, currentValue: 0, prefix: p, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: { currentValue: 0, prefix: p, isActive: true },
    });
    await dbInternal.numberRange.updateMany({ where: { orgId, docType, year: { not: 2222 } }, data: { isActive: false } });
  }
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "STRIPE" } });
  await dbInternal.paymentProviderAccount.create({
    data: {
      orgId,
      provider: "STRIPE",
      enabled: true,
      mode,
      apiKeyEnc: encryptSecret(mode === "LIVE" ? FAKE_STRIPE_LIVE_KEY : FAKE_STRIPE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE),
      webhookSecretEnc: opts.noSecret ? null : encryptSecret(FAKE_STRIPE_SIGNING_SECRET, PAYMENT_WEBHOOK_SECRET_PURPOSE),
      webhookPathId: `wh-${orgId}`,
      lastTestOk: true,
    },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Webhook Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId: customer.id,
      issueDate: NOW,
      deliveryDate: new Date("2222-03-05"),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: NOW },
  );
  const inv = await finalizeInvoice(d.id, { now: NOW });
  const url = await revealPayLinkUrl(orgId, inv.id, BASE);
  if (!url) throw new Error("Link fehlt");
  const link = await dbInternal.invoicePayLink.findFirstOrThrow({ where: { invoiceId: inv.id }, select: { id: true } });
  return { orgId, invoiceId: inv.id, linkId: link.id, webhookPath: `wh-${orgId}` };
}
type S = Awaited<ReturnType<typeof setup>>;

async function newAttempt(s: S, o: { status?: string; paymentRef?: string } = {}) {
  counter += 1;
  const n = String(counter).padStart(6, "0");
  const sessionId = `cs_live_FAKEweb${n}`;
  const pi = `pi_FAKEweb${n}`;
  const row = await dbInternal.paymentProviderAttempt.create({
    data: {
      orgId: s.orgId,
      payLinkId: s.linkId,
      provider: "STRIPE",
      amountCents: 11900,
      currency: "EUR",
      status: o.status ?? "OPEN",
      providerObjectId: sessionId,
      checkoutUrl: `https://checkout.stripe.com/c/pay/${sessionId}`,
      ...(o.paymentRef ? { providerPaymentRef: o.paymentRef } : {}),
      createdAt: NOW,
    },
    select: { id: true },
  });
  return { id: row.id, sessionId, pi };
}
type A = Awaited<ReturnType<typeof newAttempt>>;

/** Sitzung aus einer Fixture mit Ids des Tests. */
function sessionJson(fixture: string, a: A): string {
  const j = JSON.parse(stripeFixture(fixture)) as { id: string; client_reference_id: string; payment_intent: { id: string } };
  j.id = a.sessionId;
  j.client_reference_id = a.id;
  j.payment_intent.id = a.pi;
  return JSON.stringify(j);
}
function disputesJson(fixture: string, a: A): string {
  const j = JSON.parse(stripeFixture(fixture)) as { data: { payment_intent: string }[] };
  for (const d of j.data) d.payment_intent = a.pi;
  return JSON.stringify(j);
}
function eventJson(fixture: string, patch: { sessionId?: string; pi?: string; livemode?: boolean; type?: string }): string {
  const j = JSON.parse(stripeFixture(fixture)) as { type: string; livemode: boolean; data: { object: Record<string, unknown> } };
  if (patch.type) j.type = patch.type;
  if (patch.livemode !== undefined) j.livemode = patch.livemode;
  if (patch.sessionId) j.data.object.id = patch.sessionId;
  if (patch.pi) j.data.object.payment_intent = patch.pi;
  return JSON.stringify(j);
}
const completed = (a: A, type = "checkout.session.completed") => eventJson("event-checkout-completed", { sessionId: a.sessionId, type });

function fakeFor(a: A, session: string, disputes?: string) {
  return createStripeFake({
    [`GET /checkout/sessions/${a.sessionId}`]: () => ({ status: 200, text: session }),
    ...(disputes ? { "GET /disputes": () => ({ status: 200, text: disputes }) } : {}),
  });
}

type Fake = ReturnType<typeof createStripeFake>;
function hook(s: S, body: string | Buffer, fake: Fake, o: { secret?: string; t?: number; header?: string | null; now?: Date } = {}) {
  const headers = new Headers();
  const header = o.header === undefined ? signStripeEvent(body, o.secret ?? FAKE_STRIPE_SIGNING_SECRET, o.t ?? T) : o.header;
  if (header !== null) headers.set("stripe-signature", header);
  return handleProviderWebhook("stripe", s.webhookPath, body, headers, { transport: fake.transport, now: o.now ?? NOW });
}

const paymentsOf = (invoiceId: string) =>
  dbInternal.payment.findMany({
    where: { invoiceId },
    select: { amountCents: true, method: true, provider: true, providerPaymentId: true, createdBy: true, kind: true, reason: true },
    orderBy: { createdAt: "asc" },
  });
const attemptOf = (id: string) => dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id }, select: { status: true, providerPaymentRef: true } });
const invoiceOf = (id: string) => dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmountCents: true } });
const eventsOf = (orgId: string) => dbInternal.paymentProviderEvent.findMany({ where: { orgId }, select: { eventId: true, result: true, detail: true } });
const notesOf = (orgId: string) => dbInternal.notification.findMany({ where: { orgId }, select: { type: true, title: true, body: true } });

describe("Stripe-Webhook: Buchung", () => {
  it("completed bucht genau eine Zahlung (STRIPE/pi/webhook), Ref am Vorgang, Rechnung PAID, Webhook-Outbox, nur die STRIPE-Regel laeuft", async () => {
    const s = await setup("Stripe Hook Bezahlt GmbH");
    const ep = await createWebhookEndpoint(s.orgId, { url: "https://93.184.216.40/hook", events: ["payment.recorded"] }, { now: NOW });
    await createPaymentRule(s.orgId, { name: "Nur Stripe", trigger: "PAID_FULL", sources: ["STRIPE"], actions: [{ type: "NOTIFY" }] }, "tester");
    await createPaymentRule(s.orgId, { name: "Nur Mollie", trigger: "PAID_FULL", sources: ["MOLLIE"], actions: [{ type: "NOTIFY" }] }, "tester");
    const a = await newAttempt(s);
    const fake = fakeFor(a, sessionJson("session-paid", a));
    expect(await hook(s, completed(a), fake)).toEqual({ status: 200 });
    expect(await paymentsOf(s.invoiceId)).toEqual([
      { amountCents: 11900, method: "ONLINE", provider: "STRIPE", providerPaymentId: a.pi, createdBy: "webhook", kind: "PAYMENT", reason: null },
    ]);
    expect(await attemptOf(a.id)).toEqual({ status: "PAID", providerPaymentRef: a.pi });
    expect((await invoiceOf(s.invoiceId)).status).toBe("PAID");
    const events = (await dbInternal.webhookDelivery.findMany({ where: { endpointId: ep.id }, select: { event: true } })).map((d) => d.event);
    expect(events).toContain("payment.recorded");
    const runs = await dbInternal.paymentRuleRun.findMany({ where: { orgId: s.orgId }, select: { source: true } });
    expect(runs).toEqual([{ source: "STRIPE" }]);
  });

  it("gleiches Ereignis zweimal, completed + async_payment_succeeded + Abgleich parallel: eine Zahlung", async () => {
    const s = await setup("Stripe Hook Doppelt GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(a, sessionJson("session-paid", a));
    await hook(s, completed(a), fake);
    await hook(s, completed(a), fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
    const s2 = await setup("Stripe Hook Parallel GmbH");
    const a2 = await newAttempt(s2);
    const fake2 = fakeFor(a2, sessionJson("session-paid", a2));
    await Promise.all([
      hook(s2, completed(a2), fake2),
      hook(s2, completed(a2, "checkout.session.async_payment_succeeded"), fake2),
      refreshAttempt(s2.orgId, a2.id, { createdBy: "scheduler", actor: "t", transport: fake2.transport, now: NOW }),
    ]);
    expect(await paymentsOf(s2.invoiceId)).toHaveLength(1);
    expect((await eventsOf(s2.orgId)).filter((e) => e.result === "APPLIED")).toHaveLength(1);
  });

  it("asynchron: unpaid+processing bucht nichts, spaeter async_payment_succeeded bucht; async_payment_failed -> FAILED", async () => {
    const s = await setup("Stripe Hook Async GmbH");
    const a = await newAttempt(s);
    const states = { text: sessionJson("session-async-processing", a) };
    const fake = createStripeFake({ [`GET /checkout/sessions/${a.sessionId}`]: () => ({ status: 200, text: states.text }) });
    await hook(s, completed(a), fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
    expect((await attemptOf(a.id)).status).toBe("OPEN");
    states.text = sessionJson("session-paid", a);
    await hook(s, completed(a, "checkout.session.async_payment_succeeded"), fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
    const s2 = await setup("Stripe Hook Async Fehl GmbH");
    const a2 = await newAttempt(s2);
    await hook(s2, completed(a2, "checkout.session.async_payment_failed"), fakeFor(a2, sessionJson("session-async-failed", a2)));
    expect(await paymentsOf(s2.invoiceId)).toHaveLength(0);
    expect((await attemptOf(a2.id)).status).toBe("FAILED");
  });

  it("Testmodus-Konto: keine Zahlung, Ereignis TEST", async () => {
    const s = await setup("Stripe Hook Test GmbH", { mode: "TEST" });
    const a = await newAttempt(s);
    const j = JSON.parse(sessionJson("session-test-mode", a)) as { id: string };
    j.id = a.sessionId.replace("cs_live_", "cs_test_");
    await dbInternal.paymentProviderAttempt.update({ where: { id: a.id }, data: { providerObjectId: j.id } });
    const fake = createStripeFake({ [`GET /checkout/sessions/${j.id}`]: () => ({ status: 200, text: JSON.stringify(j) }) });
    const body = eventJson("event-checkout-completed", { sessionId: j.id, livemode: false });
    expect(await hook(s, body, fake)).toEqual({ status: 200 });
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
    expect((await eventsOf(s.orgId)).map((e) => e.result)).toEqual(["TEST"]);
  });
});

describe("Stripe-Webhook: Signatur und Zuordnung", () => {
  it("ungueltige Signatur, falscher Schluessel, Replay (6 min), manipulierter Body, ohne Header: 400, kein Netz, keine Zahlung, genau eine Tagesmeldung", async () => {
    const s = await setup("Stripe Hook Signatur GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(a, sessionJson("session-paid", a));
    const body = completed(a);
    const wrongKey = ["whsec", "WRONG" + "c".repeat(27)].join("_");
    const results = [
      await hook(s, body, fake, { header: "t=1,v1=" + "0".repeat(64) }),
      await hook(s, body, fake, { secret: wrongKey }),
      await hook(s, body, fake, { t: T - 360 }),
      await hook(s, body + " ", fake, { header: signStripeEvent(body, FAKE_STRIPE_SIGNING_SECRET, T) }),
      await hook(s, body, fake, { header: null }),
    ];
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
    expect((await notesOf(s.orgId)).filter((n) => n.title.includes("Signatur"))).toHaveLength(1);
  });

  it("Fehler beim Schreiben der Signaturmeldung aendert die Antwort nicht (immer 400)", async () => {
    const s = await setup("Stripe Hook Meldefehler GmbH");
    const a = await newAttempt(s);
    const spy = vi.spyOn(dbInternal.notification, "create").mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = fakeFor(a, sessionJson("session-paid", a));
    expect(await hook(s, completed(a), fake, { header: "t=1,v1=" + "0".repeat(64) })).toEqual({ status: 400 });
    spy.mockRestore();
    err.mockRestore();
    expect(fake.calls).toHaveLength(0);
  });

  it("Thin-Ereignis: 400 + Meldung; irrelevanter Typ: 200 ohne Netz", async () => {
    const s = await setup("Stripe Hook Thin GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(a, sessionJson("session-paid", a));
    expect(await hook(s, stripeFixture("event-thin"), fake)).toEqual({ status: 400 });
    expect((await notesOf(s.orgId)).some((n) => n.body?.includes("Snapshot"))).toBe(true);
    expect(await hook(s, completed(a, "customer.created"), fake)).toEqual({ status: 200 });
    expect(fake.calls).toHaveLength(0);
  });

  it("fremdes Objekt (Webshop), Vorgang anderer Org, livemode-Abweichung: 200 ohne Netz", async () => {
    const s = await setup("Stripe Hook Fremd GmbH");
    const other = await setup("Stripe Hook Andere Org GmbH");
    const a = await newAttempt(other);
    const own = await newAttempt(s);
    const fake = fakeFor(a, sessionJson("session-paid", a));
    expect(await hook(s, eventJson("event-checkout-completed", { sessionId: "cs_live_FAKEwebshop0001" }), fake)).toEqual({ status: 200 });
    expect(await hook(s, eventJson("event-charge-refunded", { pi: "pi_FAKEwebshop0001" }), fake)).toEqual({ status: 200 });
    expect(await hook(s, completed(a), fake)).toEqual({ status: 200 });
    expect(await hook(s, eventJson("event-checkout-completed", { sessionId: own.sessionId, livemode: false }), fake)).toEqual({ status: 200 });
    expect(fake.calls).toHaveLength(0);
    expect(await paymentsOf(other.invoiceId)).toHaveLength(0);
  });

  it("kein Signaturschluessel: 503; Body 300 KiB: 400", async () => {
    const s = await setup("Stripe Hook Ohne Schluessel GmbH", { noSecret: true });
    const fake = createStripeFake();
    expect(await hook(s, stripeFixture("event-checkout-completed"), fake)).toEqual({ status: 503 });
    const s2 = await setup("Stripe Hook Gross GmbH");
    const big = Buffer.alloc(300 * 1024, 0x20);
    expect(await hook(s2, big, fake)).toEqual({ status: 400 });
    expect(await hook(s2, Buffer.alloc(129 * 1024, 0x20), fake)).toEqual({ status: 400 });
    expect(fake.calls).toHaveLength(0);
  });

  it("Zahlungs-Id schon an anderem Vorgang: keine Buchung, Ereignis protokolliert, Meldung, Antwort 200", async () => {
    const s = await setup("Stripe Hook Konflikt GmbH");
    const first = await newAttempt(s);
    const second = await newAttempt(s);
    await dbInternal.paymentProviderAttempt.update({ where: { id: first.id }, data: { providerPaymentRef: second.pi } });
    const fake = fakeFor(second, sessionJson("session-paid", second));
    expect(await hook(s, completed(second), fake)).toEqual({ status: 200 });
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
    expect((await eventsOf(s.orgId)).some((e) => e.result === "IGNORED" && e.eventId.endsWith("#refconflict"))).toBe(true);
    expect((await notesOf(s.orgId)).some((n) => n.body?.includes("anderen Bezahlvorgang"))).toBe(true);
  });
});

describe("Stripe-Webhook: Erstattung und Streitfall", () => {
  async function paidSetup(name: string) {
    const s = await setup(name);
    const a = await newAttempt(s);
    const session = { text: sessionJson("session-paid", a) };
    const disputes = { text: JSON.stringify({ object: "list", data: [] }) };
    const fake = createStripeFake({
      [`GET /checkout/sessions/${a.sessionId}`]: () => ({ status: 200, text: session.text }),
      "GET /disputes": () => ({ status: 200, text: disputes.text }),
    });
    await hook(s, completed(a), fake);
    return { s, a, session, disputes, fake };
  }

  it("charge.refunded (Teil 19,00) ordnet ueber die Zahlungs-Id zu und gegenbucht; erneut nichts", async () => {
    const { s, a, session, fake } = await paidSetup("Stripe Hook Erstattung GmbH");
    session.text = sessionJson("session-paid-refunded-partial", a).replace('"amount_refunded": 5000', '"amount_refunded": 1900').replace('"amount_refunded":5000', '"amount_refunded":1900');
    const body = eventJson("event-charge-refunded", { pi: a.pi });
    expect(await hook(s, body, fake)).toEqual({ status: 200 });
    const pays = await paymentsOf(s.invoiceId);
    expect(pays.map((p) => [p.kind, p.amountCents])).toEqual([["PAYMENT", 11900], ["REVERSAL", -1900]]);
    expect(await hook(s, body, fake)).toEqual({ status: 200 });
    expect(await paymentsOf(s.invoiceId)).toHaveLength(2);
  });

  it("charge.refunded mit Teilgutschrift: keine Gegenbuchung, eine Meldung", async () => {
    const { s, a, session, fake } = await paidSetup("Stripe Hook Gutschrift GmbH");
    await createPartialCreditNote(s.invoiceId, { lines: [{ description: "Teilgutschrift", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 19, taxCategory: "S" }] }, { orgId: s.orgId, now: NOW });
    session.text = sessionJson("session-paid-refunded-partial", a);
    await hook(s, eventJson("event-charge-refunded", { pi: a.pi }), fake);
    expect((await paymentsOf(s.invoiceId)).filter((p) => p.kind === "REVERSAL")).toHaveLength(0);
    expect((await notesOf(s.orgId)).filter((n) => n.title.includes("Erstattung"))).toHaveLength(1);
  });

  it("charge.dispute.funds_withdrawn gegenbucht (Chargeback); funds_reinstated: nur Meldung; Warnung: nichts", async () => {
    const { s, a, session, disputes, fake } = await paidSetup("Stripe Hook Dispute GmbH");
    session.text = sessionJson("session-paid-disputed", a);
    disputes.text = disputesJson("disputes-withdrawn", a);
    await hook(s, eventJson("event-dispute-funds-withdrawn", { pi: a.pi }), fake);
    const pays = await paymentsOf(s.invoiceId);
    expect(pays.map((p) => [p.kind, p.amountCents])).toEqual([["PAYMENT", 11900], ["REVERSAL", -11900]]);
    expect(pays[1]!.reason ?? "").toMatch(/R(ü|ue)ckbuchung|Chargeback|Streit/i);
    disputes.text = disputesJson("disputes-reinstated", a);
    await hook(s, eventJson("event-dispute-funds-withdrawn", { pi: a.pi, type: "charge.dispute.funds_reinstated" }), fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(2);
    expect((await notesOf(s.orgId)).some((n) => n.body?.includes("verringert oder aufgehoben"))).toBe(true);
  });

  it("Dispute mit Warnung ohne Saldobuchung: keine Gegenbuchung", async () => {
    const { s, a, session, disputes, fake } = await paidSetup("Stripe Hook Warnung GmbH");
    session.text = sessionJson("session-paid-disputed", a);
    disputes.text = disputesJson("disputes-warning", a);
    await hook(s, eventJson("event-dispute-funds-withdrawn", { pi: a.pi, type: "charge.dispute.created" }), fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
  });

  it("charge.refunded vor jedem Session-Ereignis (Ref noch NULL): 200 ohne Netz; Abgleich holt die Erstattung nach", async () => {
    const s = await setup("Stripe Hook Frueh GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(a, sessionJson("session-paid-refunded-partial", a));
    expect(await hook(s, eventJson("event-charge-refunded", { pi: a.pi }), fake)).toEqual({ status: 200 });
    expect(fake.calls).toHaveLength(0);
    await refreshAttempt(s.orgId, a.id, { createdBy: "scheduler", actor: "t", transport: fake.transport, now: NOW });
    expect((await paymentsOf(s.invoiceId)).map((p) => p.kind)).toEqual(["PAYMENT", "REVERSAL"]);
  });
});

describe("Stripe: Geheimnisse und Bankhinweis", () => {
  it("Schluessel und Signaturschluessel in keiner Protokollzeile und keiner Konsolenausgabe", async () => {
    const logs: string[] = [];
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    const s = await setup("Stripe Hook Geheim GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(a, sessionJson("session-paid", a));
    await hook(s, completed(a), fake, { secret: "whsec_nichtderrichtige" });
    await hook(s, completed(a), fake);
    await hook(s, completed(a), createStripeFake());
    const dump = JSON.stringify([
      await dbInternal.paymentProviderEvent.findMany({ where: { orgId: s.orgId } }),
      await dbInternal.notification.findMany({ where: { orgId: s.orgId } }),
      await dbInternal.activityLog.findMany({ where: { orgId: s.orgId } }),
      await dbInternal.changeLog.findMany({ where: { orgId: s.orgId } }),
      logs,
    ]);
    for (const secret of [FAKE_STRIPE_SIGNING_SECRET, FAKE_STRIPE_LIVE_KEY, "whsec_nichtderrichtige"]) expect(dump).not.toContain(secret);
  });

  it("Auszahlung 'STRIPE PAYMENTS UK LTD': keine Vorschlaege, Anbieter-Hinweis", () => {
    const tx = { counterpartyName: "STRIPE PAYMENTS UK LTD", remittance: "STRIPE PAYMENTS UK LTD", amountCents: 11900, allocatedCents: 0, direction: "CRDT" as const, isReturn: false, currency: "EUR", bookingDate: NOW, endToEndId: null, counterpartyIbanHash: null };
    expect(providerPayoutHint(tx)).toContain("Auszahlung");
    expect(suggestMatches(tx as unknown as Parameters<typeof suggestMatches>[0], { invoices: [], hints: new Map() } as unknown as Parameters<typeof suggestMatches>[1])).toEqual([]);
  });

  it("revealPayLinkUrl im Livekonto markiert den Link als ausgegeben", async () => {
    const s = await setup("Stripe Hook Ausgabe GmbH");
    await dbInternal.invoicePayLink.updateMany({ where: { id: s.linkId }, data: { liveIssued: false } });
    await revealPayLinkUrl(s.orgId, s.invoiceId, BASE);
    expect((await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: s.linkId }, select: { liveIssued: true } })).liveIssued).toBe(true);
  });
});
