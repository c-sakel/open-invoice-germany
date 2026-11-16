/**
 * Online-Zahlung: Webhook, Abgleich, Buchung, Erstattung/Rueckbuchung, Storno und Scheduler (Fake-Transport, kein Netz).
 * Testjahr 2217, je Test eigene Organisation (Belegnummern sind instanzweit eindeutig).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { createPartialCreditNote } from "@/domain/invoice/credit";
import { recordPayment } from "@/domain/invoice/payment";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { handleProviderWebhook } from "@/domain/online-payment/webhook";
import { reconcileAttempt, refreshAttempt } from "@/domain/online-payment/reconcile";
import { cancelOpenAttempts, onlinePaymentCancelIdle, setOnlinePaymentTransportOverride } from "@/domain/online-payment/cancel-open";
import { processOnlinePaymentPolls, refreshLatestAttempt } from "@/domain/online-payment/poll";
import { createPaymentRule } from "@/domain/payment-rule/rules";
import { providerPayoutHint, suggestMatches } from "@/domain/bank/match";
import { createInvoiceSchema } from "@/schemas";
import { onPaymentChangedKu } from "@/domain/notifications/hooks";
import { createMollieFake, FAKE_LIVE_KEY, FAKE_TEST_KEY } from "../helpers/mollie-fake";

vi.mock("@/domain/notifications/hooks", async (orig) => {
  const m = await orig<typeof import("@/domain/notifications/hooks")>();
  return { ...m, onPaymentChangedKu: vi.fn(m.onPaymentChangedKu) };
});

const YEAR = 2217;
const NOW = new Date(`${YEAR}-03-10T10:00:00.000Z`);
const BASE = "https://rechnung.example.org";
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;
let objectCounter = 0;

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
});

async function setup(name: string, opts: { mode?: "TEST" | "LIVE"; noKey?: boolean } = {}) {
  const mode = opts.mode ?? "LIVE";
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  for (const [docType, prefix] of [["INVOICE", "OW17"], ["CREDIT_NOTE", "OX17"]] as const) {
    const p = `${prefix}-${orgId.slice(-6)}-`;
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType, year: YEAR } },
      create: { orgId, docType, year: YEAR, currentValue: 0, prefix: p, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: { currentValue: 0, prefix: p, isActive: true },
    });
    await dbInternal.numberRange.updateMany({ where: { orgId, docType, year: { not: YEAR } }, data: { isActive: false } });
  }
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "MOLLIE" } });
  await dbInternal.paymentProviderAccount.create({
    data: {
      orgId,
      provider: "MOLLIE",
      enabled: true,
      mode,
      apiKeyEnc: encryptSecret(mode === "LIVE" ? FAKE_LIVE_KEY : FAKE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE),
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
      deliveryDate: new Date(`${YEAR}-03-05`),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: NOW },
  );
  const inv = await finalizeInvoice(d.id, { now: NOW });
  const url = await revealPayLinkUrl(orgId, inv.id, BASE);
  if (!url) throw new Error("Link fehlt");
  // Schluessel erst nach dem Festschreiben entfernen (sonst entsteht kein Link).
  if (opts.noKey) await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { apiKeyEnc: null } });
  const link = await dbInternal.invoicePayLink.findFirstOrThrow({ where: { invoiceId: inv.id }, select: { id: true } });
  return { orgId, invoiceId: inv.id, linkId: link.id, number: inv.number ?? "", token: url.split("/zahlen/")[1]!, webhookPath: `wh-${orgId}` };
}
type S = Awaited<ReturnType<typeof setup>>;

async function newAttempt(s: S, o: { amountCents?: number; status?: string; createdAt?: Date; object?: boolean } = {}) {
  objectCounter += 1;
  const objectId = `tr_Hook${String(objectCounter).padStart(6, "0")}`;
  const row = await dbInternal.paymentProviderAttempt.create({
    data: {
      orgId: s.orgId,
      payLinkId: s.linkId,
      provider: "MOLLIE",
      amountCents: o.amountCents ?? 11900,
      currency: "EUR",
      status: o.status ?? "OPEN",
      ...(o.object === false ? {} : { providerObjectId: objectId, checkoutUrl: `https://www.mollie.com/checkout/select-method/${objectId}` }),
      createdAt: o.createdAt ?? NOW,
    },
    select: { id: true },
  });
  return { id: row.id, objectId };
}

const dec = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
function paymentJson(id: string, attemptId: string, o: { status?: string; mode?: "live" | "test"; cents?: number; refunded?: number; chargedBack?: number } = {}): string {
  return JSON.stringify({
    resource: "payment",
    id,
    mode: o.mode ?? "live",
    status: o.status ?? "paid",
    amount: { currency: "EUR", value: dec(o.cents ?? 11900) },
    ...(o.refunded ? { amountRefunded: { currency: "EUR", value: dec(o.refunded) } } : {}),
    ...(o.chargedBack ? { amountChargedBack: { currency: "EUR", value: dec(o.chargedBack) } } : {}),
    paidAt: "2217-03-10T09:30:00+00:00",
    metadata: { attemptId },
    _links: { checkout: { href: `https://www.mollie.com/checkout/select-method/${id}` } },
  });
}

/** Fake, der je Objekt-Id den im Test gesetzten Zustand liefert. */
function fakeFor(states: Map<string, string>) {
  const fake = createMollieFake();
  fake.transport = (async (req) => {
    fake.calls.push(req);
    const m = /\/payments\/(tr_[A-Za-z0-9]+)$/.exec(new URL(req.url).pathname);
    if (req.method === "DELETE") return { status: 200, text: "{}" };
    if (req.method === "GET" && m && states.has(m[1]!)) return { status: 200, text: states.get(m[1]!)! };
    return { status: 404, text: "{}" };
  }) as typeof fake.transport;
  return fake;
}

const hook = (s: S, objectId: string, fake: ReturnType<typeof fakeFor>, body?: string) =>
  handleProviderWebhook("mollie", s.webhookPath, body ?? `id=${objectId}`, new Headers(), { transport: fake.transport, now: NOW });

const paymentsOf = (invoiceId: string) =>
  dbInternal.payment.findMany({
    where: { invoiceId },
    select: { id: true, amountCents: true, method: true, provider: true, providerPaymentId: true, createdBy: true, kind: true, reason: true, paidAt: true },
    orderBy: { createdAt: "asc" },
  });
const invoiceOf = (id: string) => dbInternal.invoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmountCents: true } });
const linkOf = (id: string) => dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id }, select: { status: true, disabledReason: true } });
const eventsOf = (orgId: string) =>
  dbInternal.paymentProviderEvent.findMany({ where: { orgId }, select: { eventId: true, result: true, detail: true, attemptId: true, orgId: true }, orderBy: { receivedAt: "asc" } });
const notesOf = (orgId: string) => dbInternal.notification.findMany({ where: { orgId }, select: { type: true, body: true } });

describe("Webhook: Buchung", () => {
  it("paid bucht genau eine Zahlung (ONLINE/MOLLIE/webhook), Rechnung bezahlt, Link aus, Regel mit Quelle MOLLIE", async () => {
    const s = await setup("Hook Bezahlt GmbH");
    await createPaymentRule(s.orgId, { name: "Nur Online", trigger: "PAID_FULL", sources: ["MOLLIE"], actions: [{ type: "NOTIFY" }] }, "tester");
    await createPaymentRule(s.orgId, { name: "Nur Bank", trigger: "PAID_FULL", sources: ["BANK"], actions: [{ type: "NOTIFY" }] }, "tester");
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)]]));
    expect(await hook(s, a.objectId, fake)).toEqual({ status: 200 });
    const pays = await paymentsOf(s.invoiceId);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ amountCents: 11900, method: "ONLINE", provider: "MOLLIE", providerPaymentId: a.objectId, createdBy: "webhook", kind: "PAYMENT" });
    expect(pays[0]!.paidAt.toISOString()).toBe("2217-03-10T09:30:00.000Z");
    expect((await invoiceOf(s.invoiceId)).status).toBe("PAID");
    expect(await linkOf(s.linkId)).toEqual({ status: "DISABLED", disabledReason: "INVOICE_PAID" });
    const ev = await eventsOf(s.orgId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ result: "APPLIED", attemptId: a.id, orgId: s.orgId });
    expect((await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } })).status).toBe("PAID");
    const runs = await dbInternal.paymentRuleRun.findMany({ where: { orgId: s.orgId }, select: { source: true } });
    expect(runs).toEqual([{ source: "MOLLIE" }]);
  });

  it("eine gebuchte Online-Zahlung wertet die Umsatzgrenzen nach dem Commit neu aus", async () => {
    const s = await setup("Hook Umsatzgrenze GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)]]));
    vi.mocked(onPaymentChangedKu).mockClear();
    await hook(s, a.objectId, fake);
    expect(vi.mocked(onPaymentChangedKu)).toHaveBeenCalledWith(s.orgId, expect.any(Date));
  });

  it("gleicher Webhook zweimal und Webhook + Abgleich parallel: eine Zahlung, ein Ereignis", async () => {
    const s = await setup("Hook Doppelt GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)]]));
    await hook(s, a.objectId, fake);
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
    const s2 = await setup("Hook Parallel 2 GmbH");
    const a2 = await newAttempt(s2);
    const fake2 = fakeFor(new Map([[a2.objectId, paymentJson(a2.objectId, a2.id)]]));
    await Promise.all([hook(s2, a2.objectId, fake2), refreshAttempt(s2.orgId, a2.id, { createdBy: "scheduler", actor: "t", transport: fake2.transport, now: NOW }), hook(s2, a2.objectId, fake2)]);
    expect(await paymentsOf(s2.invoiceId)).toHaveLength(1);
    expect((await eventsOf(s2.orgId)).filter((e) => e.result === "APPLIED")).toHaveLength(1);
  });

  it("Teil-Erstattung, erneut gleicher Zustand, volle Erstattung; Link wird bei wieder offener Rechnung reaktiviert", async () => {
    const s = await setup("Hook Erstattung GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id)]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    expect((await linkOf(s.linkId)).status).toBe("DISABLED");
    states.set(a.objectId, paymentJson(a.objectId, a.id, { refunded: 1900 }));
    await hook(s, a.objectId, fake);
    let pays = await paymentsOf(s.invoiceId);
    expect(pays).toHaveLength(2);
    expect(pays[1]).toMatchObject({ kind: "REVERSAL", amountCents: -1900, reason: "Erstattung beim Zahlungsanbieter" });
    expect((await invoiceOf(s.invoiceId)).status).toBe("PARTIALLY_PAID");
    expect(await linkOf(s.linkId)).toEqual({ status: "ACTIVE", disabledReason: null });
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(2);
    states.set(a.objectId, paymentJson(a.objectId, a.id, { refunded: 11900 }));
    await hook(s, a.objectId, fake);
    pays = await paymentsOf(s.invoiceId);
    expect(pays.filter((p) => p.kind === "REVERSAL").map((p) => p.amountCents)).toEqual([-1900, -10000]);
    expect((await invoiceOf(s.invoiceId)).paidAmountCents).toBe(0);
  });

  it("Chargeback bucht mit Chargeback-Grund gegen; manuelle Gegenbuchung vorher wird nicht verdoppelt", async () => {
    const s = await setup("Hook Chargeback GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id)]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    const [orig] = await paymentsOf(s.invoiceId);
    await reversePayment(orig!.id, { amountCents: 5000, reason: "Manuelle Korrektur" }, { actor: "tester", orgId: s.orgId, now: NOW });
    states.set(a.objectId, paymentJson(a.objectId, a.id, { chargedBack: 5000 }));
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(2);
    states.set(a.objectId, paymentJson(a.objectId, a.id, { chargedBack: 11900 }));
    await hook(s, a.objectId, fake);
    const pays = await paymentsOf(s.invoiceId);
    expect(pays).toHaveLength(3);
    expect(pays[2]).toMatchObject({ amountCents: -6900, reason: "Rueckbuchung beim Zahlungsanbieter (Chargeback)" });
    expect((await invoiceOf(s.invoiceId)).paidAmountCents).toBe(0);
  });

  it("Erstattung nach Teilgutschrift: keine Gegenbuchung, Rechnung bleibt bezahlt, eine Meldung", async () => {
    const s = await setup("Hook Gutschrift GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id)]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    expect((await invoiceOf(s.invoiceId)).status).toBe("PAID");
    await createPartialCreditNote(s.invoiceId, { lines: [{ description: "Teilgutschrift", quantityMilli: 1000, unitNetPriceCents: 2521, taxRate: 19, taxCategory: "S" }] }, { orgId: s.orgId, now: NOW });
    states.set(a.objectId, paymentJson(a.objectId, a.id, { refunded: 3000 }));
    await hook(s, a.objectId, fake);
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
    expect((await invoiceOf(s.invoiceId)).status).toBe("PAID");
    const notes = (await notesOf(s.orgId)).filter((n) => n.type === "ONLINE_PAYMENT_ISSUE");
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("bitte manuell zuordnen");
  });

  it("aufgehobene Erstattung beim Anbieter: nur Benachrichtigung, keine Neubuchung", async () => {
    const s = await setup("Hook Aufgehoben GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id)]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    states.set(a.objectId, paymentJson(a.objectId, a.id, { refunded: 3000 }));
    await hook(s, a.objectId, fake);
    states.set(a.objectId, paymentJson(a.objectId, a.id, { refunded: 1000 }));
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(2);
    expect((await notesOf(s.orgId)).some((n) => n.type === "ONLINE_PAYMENT_ISSUE")).toBe(true);
  });
});

describe("Webhook: Wiederkehr des Erstattungsstands", () => {
  it("3000 -> 1000 -> 3000 -> 1000 mit Replays: genau eine Gegenbuchung, je Stufe nur ein Ereignis", async () => {
    const s = await setup("Hook Wiederkehr GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id)]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    for (const refunded of [3000, 1000, 3000, 1000]) {
      states.set(a.objectId, paymentJson(a.objectId, a.id, { refunded }));
      await hook(s, a.objectId, fake);
      await hook(s, a.objectId, fake);
    }
    const pays = await paymentsOf(s.invoiceId);
    expect(pays.filter((p) => p.kind === "REVERSAL").map((p) => p.amountCents)).toEqual([-3000]);
    const ids = (await eventsOf(s.orgId)).map((e) => e.eventId).filter((id) => /:3000:0|:1000:0/.test(id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
  });
});

describe("Webhook: Ueberzahlung und Wettlauf", () => {
  it("Rest kleiner als Vorgang: bis zum Rest gebucht, Ueberzahlung gemeldet", async () => {
    const s = await setup("Hook Ueber GmbH");
    await recordPayment(s.invoiceId, { amountCents: 6900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { actor: "tester", orgId: s.orgId, now: NOW });
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)]]));
    await hook(s, a.objectId, fake);
    const pays = (await paymentsOf(s.invoiceId)).filter((p) => p.provider === "MOLLIE");
    expect(pays.map((p) => p.amountCents)).toEqual([5000]);
    expect((await invoiceOf(s.invoiceId)).status).toBe("PAID");
    const notes = await notesOf(s.orgId);
    expect(notes.filter((n) => n.type === "ONLINE_OVERPAYMENT")).toHaveLength(1);
    expect(notes.find((n) => n.type === "ONLINE_OVERPAYMENT")!.body).toContain("69,00 EUR");
  });

  it("zwei bezahlte Vorgaenge derselben Rechnung: nie ueber den Rest, nie doppelt, Rest als Ueberzahlung", async () => {
    const s = await setup("Hook Wettlauf GmbH");
    const a = await newAttempt(s, { amountCents: 7900 });
    const b = await newAttempt(s, { amountCents: 7900 });
    const fake = fakeFor(new Map([
      [a.objectId, paymentJson(a.objectId, a.id, { cents: 7900 })],
      [b.objectId, paymentJson(b.objectId, b.id, { cents: 7900 })],
    ]));
    await Promise.all([hook(s, a.objectId, fake), hook(s, b.objectId, fake)]);
    const pays = (await paymentsOf(s.invoiceId)).filter((p) => p.kind === "PAYMENT");
    expect(pays.map((p) => p.amountCents).sort((x, y) => x - y)).toEqual([4000, 7900]);
    expect(new Set(pays.map((p) => p.providerPaymentId)).size).toBe(2);
    const inv = await invoiceOf(s.invoiceId);
    expect(inv).toEqual({ status: "PAID", paidAmountCents: 11900 });
    expect((await notesOf(s.orgId)).filter((n) => n.type === "ONLINE_OVERPAYMENT")).toHaveLength(1);
    // Ein dritter Vorgang bei bereits bezahlter Rechnung wird nicht gebucht, aber gemeldet.
    const c = await newAttempt(s, { amountCents: 5000 });
    const fake3 = fakeFor(new Map([[c.objectId, paymentJson(c.objectId, c.id, { cents: 5000 })]]));
    await hook(s, c.objectId, fake3);
    expect((await paymentsOf(s.invoiceId)).filter((p) => p.kind === "PAYMENT")).toHaveLength(2);
    expect((await notesOf(s.orgId)).filter((n) => n.type === "ONLINE_PAYMENT_ISSUE")).toHaveLength(1);
  });

  it("Rechnung storniert: keine Zahlung, Hinweis, Vorgang PAID", async () => {
    const s = await setup("Hook Storniert GmbH");
    const a = await newAttempt(s);
    await cancelInvoice(s.invoiceId, { actor: "tester", orgId: s.orgId, now: NOW });
    await onlinePaymentCancelIdle();
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)]]));
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
    expect((await notesOf(s.orgId)).filter((n) => n.type === "ONLINE_PAYMENT_ISSUE")).toHaveLength(1);
  });
});

describe("Webhook: Modus und Eingabe", () => {
  it("Testmodus-Konto bucht nie (Ereignis TEST, Hinweis); Modus-Abweichung: ERROR", async () => {
    const t = await setup("Hook Test GmbH", { mode: "TEST" });
    const a = await newAttempt(t);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id, { mode: "test" })]]));
    await hook(t, a.objectId, fake);
    expect(await paymentsOf(t.invoiceId)).toHaveLength(0);
    expect((await eventsOf(t.orgId))[0]).toMatchObject({ result: "TEST" });
    expect((await notesOf(t.orgId)).some((n) => n.type === "ONLINE_PAYMENT_ISSUE")).toBe(true);
    // Live-Zugang, aber Anbieter meldet eine Testzahlung: Antwort wird verworfen, nichts gebucht.
    const l = await setup("Hook Modus GmbH");
    const b = await newAttempt(l);
    const fake2 = fakeFor(new Map([[b.objectId, paymentJson(b.objectId, b.id, { mode: "test" })]]));
    expect(await hook(l, b.objectId, fake2)).toEqual({ status: 200 });
    expect(await paymentsOf(l.invoiceId)).toHaveLength(0);
    expect((await eventsOf(l.orgId))[0]).toMatchObject({ result: "IGNORED" });
  });

  it("falscher Betrag oder fremder Vorgang im Anbieterzustand: ERROR, nichts gebucht", async () => {
    const s = await setup("Hook Betrag GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id, { cents: 100 })]]));
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
    expect((await eventsOf(s.orgId))[0]).toMatchObject({ result: "ERROR" });
  });

  it("fremde oder unbekannte Objekt-Id: 200 ohne Netzaufruf; unbekannter Pfad 404; falscher Body 400; Anbieter 500 -> 503", async () => {
    const s = await setup("Hook Fremd GmbH");
    const other = await setup("Hook Fremd Andere GmbH");
    const foreign = await newAttempt(other);
    const fake = fakeFor(new Map([[foreign.objectId, paymentJson(foreign.objectId, foreign.id)]]));
    expect(await hook(s, foreign.objectId, fake)).toEqual({ status: 200 });
    expect(await hook(s, "tr_Unbekannt01", fake)).toEqual({ status: 200 });
    expect(fake.calls).toHaveLength(0);
    expect(await paymentsOf(other.invoiceId)).toHaveLength(0);
    expect(await handleProviderWebhook("mollie", "wh-gibt-es-nicht-1234567", "id=tr_Abcd1234", new Headers(), { transport: fake.transport })).toEqual({ status: 404 });
    expect(await handleProviderWebhook("stripe", s.webhookPath, "id=tr_Abcd1234", new Headers(), { transport: fake.transport })).toEqual({ status: 404 });
    expect(await hook(s, "x", fake, '{"id":"tr_Abcd1234"}')).toEqual({ status: 400 });
    expect(await hook(s, "x", fake, `id=tr_Abcd1234&x=${"a".repeat(2000)}`)).toEqual({ status: 400 });
    const a = await newAttempt(s);
    const broken = createMollieFake({ [`GET /payments/${a.objectId}`]: { status: 500, text: JSON.stringify({ detail: "GEHEIMER-ANBIETERTEXT" }) } });
    expect(await hook(s, a.objectId, broken as unknown as ReturnType<typeof fakeFor>)).toEqual({ status: 503 });
    expect(await eventsOf(s.orgId)).toHaveLength(0);
  });

  it("kein Schluessel: 503 und Hinweis", async () => {
    const s = await setup("Hook Ohne Schluessel GmbH", { noKey: true });
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)]]));
    expect(await hook(s, a.objectId, fake)).toEqual({ status: 503 });
    expect(fake.calls).toHaveLength(0);
    expect((await notesOf(s.orgId)).filter((n) => n.type === "ONLINE_PAYMENT_ISSUE")).toHaveLength(1);
  });

  it("expired/canceled setzen nur den Vorgangsstatus; Konto aus bucht trotzdem", async () => {
    const s = await setup("Hook Ablauf GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id, { status: "expired" })]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    expect((await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } })).status).toBe("EXPIRED");
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
    const b = await newAttempt(s);
    await dbInternal.paymentProviderAccount.updateMany({ where: { orgId: s.orgId }, data: { enabled: false } });
    states.set(b.objectId, paymentJson(b.objectId, b.id));
    await hook(s, b.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
  });
});

describe("Storno, Vollzahlung aus anderer Quelle, Scheduler", () => {
  it("Storno mit offenem Vorgang: Link aus, DELETE beim Anbieter, Fehler beim Abbruch bricht das Storno nicht", async () => {
    const s = await setup("Hook Storno GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id, { status: "canceled" })]]);
    const fake = fakeFor(states);
    setOnlinePaymentTransportOverride(fake.transport);
    await cancelInvoice(s.invoiceId, { actor: "tester", orgId: s.orgId, now: NOW });
    await onlinePaymentCancelIdle();
    expect(await linkOf(s.linkId)).toEqual({ status: "DISABLED", disabledReason: "INVOICE_CANCELLED" });
    expect(fake.calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/payments/${a.objectId}`))).toBe(true);
    expect((await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } })).status).toBe("CANCELED");

    const f = await setup("Hook Storno Fehler GmbH");
    const b = await newAttempt(f);
    setOnlinePaymentTransportOverride(async () => {
      throw new Error("Netz weg");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await cancelInvoice(f.invoiceId, { orgId: f.orgId, now: NOW });
    await onlinePaymentCancelIdle();
    spy.mockRestore();
    expect(res.creditNote.type).toBe("CREDIT_NOTE");
    expect((await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id: b.id }, select: { status: true } })).status).toBe("OPEN");
  });

  it("Vollzahlung aus anderer Quelle: Link aus, offene Vorgaenge werden beendet; Teilzahlung beendet nichts", async () => {
    const s = await setup("Hook Manuell GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id, { status: "canceled" })]]));
    setOnlinePaymentTransportOverride(fake.transport);
    await recordPayment(s.invoiceId, { amountCents: 4000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { actor: "tester", orgId: s.orgId, now: NOW });
    await onlinePaymentCancelIdle();
    expect((await linkOf(s.linkId)).status).toBe("ACTIVE");
    expect(fake.calls).toHaveLength(0);
    await recordPayment(s.invoiceId, { amountCents: 7900, method: "TRANSFER", isSkonto: false, applySkonto: false }, { actor: "tester", orgId: s.orgId, now: NOW });
    await onlinePaymentCancelIdle();
    expect(await linkOf(s.linkId)).toEqual({ status: "DISABLED", disabledReason: "INVOICE_PAID" });
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect((await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id: a.id }, select: { status: true } })).status).toBe("CANCELED");
    // Gegenbuchung der manuellen Zahlung oeffnet die Rechnung und reaktiviert den Link.
    const pays = await paymentsOf(s.invoiceId);
    await reversePayment(pays[1]!.id, { reason: "Fehlbuchung" }, { actor: "tester", orgId: s.orgId, now: NOW });
    expect((await linkOf(s.linkId)).status).toBe("ACTIVE");
  });

  it("Scheduler: OPEN aelter 15 min bucht, CREATING aelter 10 min wird ohne Netz FAILED, juengere bleiben", async () => {
    const s = await setup("Hook Job GmbH");
    const old = new Date(NOW.getTime() - 20 * 60_000);
    const a = await newAttempt(s, { createdAt: old });
    const young = await newAttempt(s, { createdAt: new Date(NOW.getTime() - 5 * 60_000) });
    const stuck = await newAttempt(s, { status: "CREATING", object: false, createdAt: new Date(NOW.getTime() - 11 * 60_000) });
    const fresh = await newAttempt(s, { status: "CREATING", object: false, createdAt: new Date(NOW.getTime() - 2 * 60_000) });
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)], [young.objectId, paymentJson(young.objectId, young.id)]]));
    const res = await processOnlinePaymentPolls({ now: NOW, transport: fake.transport });
    expect(res).toMatchObject({ checked: 1, applied: 1, errors: 0 });
    expect(fake.calls).toHaveLength(1);
    const status = async (id: string) => (await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id }, select: { status: true, error: true } }));
    expect((await status(a.id)).status).toBe("PAID");
    expect(await status(young.id)).toMatchObject({ status: "OPEN" });
    expect(await status(stuck.id)).toMatchObject({ status: "FAILED", error: "Anlage unklar" });
    expect((await status(fresh.id)).status).toBe("CREATING");
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
  });

  it("Replay gleicher Zustaende schreibt den Pruefzeitpunkt fort (25 offene Vorgaenge, Reihum statt Verdraengung)", async () => {
    const s = await setup("Hook Reihum GmbH");
    const old = new Date(NOW.getTime() - 60 * 60_000);
    const states = new Map<string, string>();
    for (let i = 0; i < 25; i += 1) {
      const a = await newAttempt(s, { createdAt: old });
      states.set(a.objectId, paymentJson(a.objectId, a.id, { status: "open" }));
    }
    const fake = fakeFor(states);
    const t2 = new Date(NOW.getTime() + 20 * 60_000);
    const t3 = new Date(NOW.getTime() + 40 * 60_000);
    const mine = () => dbInternal.paymentProviderAttempt.count({ where: { orgId: s.orgId, lastCheckedAt: { not: null } } });
    await processOnlinePaymentPolls({ now: NOW, transport: fake.transport });
    expect(await mine()).toBe(20);
    await processOnlinePaymentPolls({ now: t2, transport: fake.transport });
    const rows = await dbInternal.paymentProviderAttempt.findMany({ where: { orgId: s.orgId }, select: { lastCheckedAt: true } });
    expect(rows.every((r) => r.lastCheckedAt !== null)).toBe(true);
    // Der zweite Lauf hat die 5 ungeprueften und 15 unveraenderte (Duplikat) fortgeschrieben.
    expect(rows.filter((r) => r.lastCheckedAt?.getTime() === t2.getTime())).toHaveLength(20);
    await processOnlinePaymentPolls({ now: t3, transport: fake.transport });
    const stale = await dbInternal.paymentProviderAttempt.count({ where: { orgId: s.orgId, lastCheckedAt: { lt: t2 } } });
    expect(stale).toBe(0);
    expect(await dbInternal.paymentProviderAttempt.count({ where: { orgId: s.orgId, lastCheckedAt: t3 } })).toBe(20);
  });

  it("Nachpruefung: bezahlter Vorgang mit verlorenem Erstattungs-Webhook wird spaeter gegengebucht", async () => {
    const s = await setup("Hook Nachpruefung GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id)]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
    states.set(a.objectId, paymentJson(a.objectId, a.id, { refunded: 11900 }));
    const later = new Date(NOW.getTime() + 7 * 60 * 60_000);
    await processOnlinePaymentPolls({ now: later, transport: fake.transport });
    const pays = await paymentsOf(s.invoiceId);
    expect(pays.map((p) => p.kind)).toEqual(["PAYMENT", "REVERSAL"]);
  });

  it("offener Vorgang nach 5 Tagen wird noch taeglich geprueft, nach 15 Tagen nicht mehr", async () => {
    const s = await setup("Hook Spaet GmbH");
    const day = 24 * 60 * 60_000;
    const five = await newAttempt(s, { createdAt: new Date(NOW.getTime() - 5 * day) });
    const fifteen = await newAttempt(s, { createdAt: new Date(NOW.getTime() - 15 * day) });
    const fake = fakeFor(new Map([[five.objectId, paymentJson(five.objectId, five.id, { status: "expired" })], [fifteen.objectId, paymentJson(fifteen.objectId, fifteen.id, { status: "expired" })]]));
    const res = await processOnlinePaymentPolls({ now: NOW, transport: fake.transport });
    expect(res.checked).toBe(1);
    const st = async (id: string) => (await dbInternal.paymentProviderAttempt.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    expect(await st(five.id)).toBe("EXPIRED");
    expect(await st(fifteen.id)).toBe("OPEN");
  });

  it("Anlage unklar: einmaliger Hinweis mit Rechnungsnummer", async () => {
    const s = await setup("Hook Unklar GmbH");
    await newAttempt(s, { status: "CREATING", object: false, createdAt: new Date(NOW.getTime() - 11 * 60_000) });
    const fake = fakeFor(new Map());
    await processOnlinePaymentPolls({ now: NOW, transport: fake.transport });
    await processOnlinePaymentPolls({ now: NOW, transport: fake.transport });
    const notes = (await notesOf(s.orgId)).filter((n) => (n.body ?? "").includes("nicht sicher angelegt"));
    expect(notes).toHaveLength(1);
  });

  it("Rate-Limit 429 (IP und Pfad) und uebergrosser Body (Reader) -> 400 ohne Netz", async () => {
    const s = await setup("Hook Limit GmbH");
    const fake = fakeFor(new Map());
    const ipHeaders = new Headers({ "cf-connecting-ip": `203.0.113.${(objectCounter % 200) + 20}`, "x-real-ip": "198.51.100.77", "x-forwarded-for": "198.51.100.77" });
    const call = (hdr: Headers, limits: { ip?: number; path?: number }) =>
      handleProviderWebhook("mollie", s.webhookPath, "id=tr_Abcd1234", hdr, { transport: fake.transport, now: NOW, limits });
    expect((await call(ipHeaders, { ip: 2 })).status).toBe(200);
    expect((await call(ipHeaders, { ip: 2 })).status).toBe(200);
    expect((await call(ipHeaders, { ip: 2 })).status).toBe(429);
    const s2 = await setup("Hook Limit Pfad GmbH");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const h = new Headers({ "cf-connecting-ip": `203.0.113.${100 + i}`, "x-real-ip": `198.51.100.${100 + i}`, "x-forwarded-for": `198.51.100.${100 + i}` });
      statuses.push((await handleProviderWebhook("mollie", s2.webhookPath, "id=tr_Abcd1234", h, { transport: fake.transport, now: NOW, limits: { path: 2 } })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(200);
    let read = false;
    const big = await handleProviderWebhook("mollie", s.webhookPath, async () => { read = true; return null; }, new Headers(), { transport: fake.transport, now: NOW });
    expect(big).toEqual({ status: 400 });
    expect(read).toBe(true);
    let readUnknown = false;
    const unknown = await handleProviderWebhook("mollie", "wh-gibt-es-nicht-1234567", async () => { readUnknown = true; return ""; }, new Headers(), { transport: fake.transport, now: NOW });
    expect(unknown).toEqual({ status: 404 });
    expect(readUnknown).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("Rueckkehrseite: refreshLatestAttempt gleicht den juengsten offenen Vorgang ab", async () => {
    const s = await setup("Hook Rueckkehr GmbH");
    const a = await newAttempt(s);
    const fake = fakeFor(new Map([[a.objectId, paymentJson(a.objectId, a.id)]]));
    await refreshLatestAttempt(s.token, { transport: fake.transport, now: NOW });
    expect(await paymentsOf(s.invoiceId)).toHaveLength(1);
  });

  it("cancelOpenAttempts ohne bezahlte/stornierte Rechnung beendet nichts", async () => {
    const s = await setup("Hook Offen GmbH");
    await newAttempt(s);
    const fake = fakeFor(new Map());
    await cancelOpenAttempts(s.orgId, s.invoiceId, { transport: fake.transport });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Geheimnisse und Bank", () => {
  it("der Schluessel steht in keiner Ereignis-, Benachrichtigungs-, Aktivitaets- oder Aenderungszeile und keiner Konsolenausgabe", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))));
    const s = await setup("Hook Geheim GmbH");
    const a = await newAttempt(s);
    const states = new Map([[a.objectId, paymentJson(a.objectId, a.id, { refunded: 1900 })]]);
    const fake = fakeFor(states);
    await hook(s, a.objectId, fake);
    await hook(s, "tr_Unbekannt02", fake);
    await handleProviderWebhook("mollie", s.webhookPath, "kaputt", new Headers(), { transport: fake.transport });
    spies.forEach((sp) => sp.mockRestore());
    const needle = FAKE_LIVE_KEY;
    const dump = JSON.stringify([
      await dbInternal.paymentProviderEvent.findMany({ where: { orgId: s.orgId } }),
      await dbInternal.notification.findMany({ where: { orgId: s.orgId } }),
      await dbInternal.activityLog.findMany({ where: { orgId: s.orgId } }),
      await dbInternal.changeLog.findMany({ where: { orgId: s.orgId } }),
      await dbInternal.paymentProviderAttempt.findMany({ where: { orgId: s.orgId } }),
    ]);
    expect(dump).not.toContain(needle);
    expect(logs.join("\n")).not.toContain(needle);
  });

  it("Auszahlung des Zahlungsanbieters: keine Rechnungsvorschlaege, Hinweis gesetzt", () => {
    const tx = { counterpartyName: "Stichting Mollie Payments", remittance: "Auszahlung 2217-03", bookingDate: NOW, amountCents: 11900, allocatedCents: 0, currency: "EUR", direction: "CRDT", counterpartyIbanHash: null, endToEndId: null };
    expect(providerPayoutHint(tx)).toContain("Auszahlung des Zahlungsanbieters");
    const ctx = {
      invoices: [{ id: "i1", number: "RE-1", customerId: "c1", customerName: "X", currency: "EUR", openCents: 11900, issueDate: NOW, dueDate: null, skontoTerms: [], mandateIbanHash: null }],
      hints: new Map<string, string>(),
    };
    expect(suggestMatches(tx, ctx)).toEqual([]);
    expect(providerPayoutHint({ counterpartyName: "Kunde GmbH", remittance: "RE-1" })).toBeNull();
    expect(suggestMatches({ ...tx, counterpartyName: "Kunde GmbH", remittance: "RE-1" }, ctx).length).toBeGreaterThan(0);
  });

  it("reconcileAttempt lehnt einen Zustand mit fremder Objekt-Id ab", async () => {
    const s = await setup("Hook Objekt GmbH");
    const a = await newAttempt(s);
    await expect(
      reconcileAttempt(a.id, { objectId: "tr_Anderes0001", testMode: false, status: "PAID", amountCents: 11900, currency: "EUR", refundedCents: 0, chargedBackCents: 0, paidAt: NOW, expiresAt: null, attemptId: a.id, paymentRef: null }, { createdBy: "webhook", actor: "t", now: NOW }),
    ).rejects.toThrow();
    expect(await paymentsOf(s.invoiceId)).toHaveLength(0);
  });
});
