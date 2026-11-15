/**
 * Online-Zahlung, Folgepunkte: Testkonto nie fuer live ausgegebene Links, Erstattung nach manueller
 * Gegenbuchung protokolliert, Hinweis ohne APP_BASE_URL. Fake-Transport, kein Netz. Testjahr 2220.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { reversePayment } from "@/domain/invoice/payment-reversal";
import { revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { startCheckout } from "@/domain/online-payment/checkout";
import { reconcileAttempt } from "@/domain/online-payment/reconcile";
import { documentPayLinkUrl, mailPayLinkUrl, portalPayPaths } from "@/domain/online-payment/document-link";
import { setProviderEnabled } from "@/domain/online-payment/settings";
import { createInvoiceSchema } from "@/schemas";
import type { ProviderPaymentState } from "@/lib/payment/types";
import { createMollieFake, FAKE_LIVE_KEY, FAKE_TEST_KEY } from "../helpers/mollie-fake";

const YEAR = 2220;
const NOW = new Date(`${YEAR}-03-10T10:00:00.000Z`);
const BASE = "https://rechnung.example.org";
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;

beforeAll(() => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = BASE;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});

async function makeOrg(name: string, mode: "TEST" | "LIVE", showOnPdf = true) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  for (const [docType, p] of [["INVOICE", "OF20"], ["CREDIT_NOTE", "OG20"]] as const) {
    const prefix = `${p}-${orgId.slice(-6)}-`;
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId, docType, year: YEAR } },
      create: { orgId, docType, year: YEAR, currentValue: 0, prefix, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: { currentValue: 0, prefix, isActive: true },
    });
    await dbInternal.numberRange.updateMany({ where: { orgId, docType, year: { not: YEAR } }, data: { isActive: false } });
  }
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "MOLLIE", showOnPdf } });
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
    data: { orgId, name: "Folge Kunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  return { orgId, customerId: customer.id };
}

async function invoiceFor(o: { orgId: string; customerId: string }, at: Date = NOW) {
  const d = await createDraftInvoice(
    o.orgId,
    createInvoiceSchema.parse({
      customerId: o.customerId,
      issueDate: at,
      deliveryDate: new Date(`${YEAR}-03-05`),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: at },
  );
  const inv = await finalizeInvoice(d.id, { now: at });
  const link = await dbInternal.invoicePayLink.findFirst({ where: { invoiceId: inv.id }, select: { id: true, onDocument: true, liveIssued: true } });
  return { invoiceId: inv.id, link };
}

const tokenOf = async (orgId: string, invoiceId: string): Promise<string> => {
  const url = await revealPayLinkUrl(orgId, invoiceId, BASE);
  if (!url) throw new Error("Link fehlt");
  return url.split("/zahlen/")[1]!;
};

let counter = 0;
function openFake() {
  return createMollieFake({
    "POST /payments": (req) => {
      const body = JSON.parse(req.body ?? "{}") as { amount: unknown; metadata: unknown };
      counter += 1;
      const id = `tr_Folge${String(counter).padStart(6, "0")}`;
      return {
        status: 201,
        text: JSON.stringify({
          resource: "payment",
          id,
          mode: "test",
          status: "open",
          amount: body.amount,
          metadata: body.metadata,
          expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
          _links: { checkout: { href: `https://www.mollie.com/checkout/select-method/${id}` } },
        }),
      };
    },
  });
}

describe("Testkonto und live ausgegebene Links", () => {
  it("im Livebetrieb angelegter Link (nicht auf dem Beleg) fuehrt nach Wechsel auf Testkonto in keinen Test-Checkout", async () => {
    const o = await makeOrg("Folge Live GmbH", "LIVE", false);
    const { invoiceId, link } = await invoiceFor(o);
    expect(link).toMatchObject({ onDocument: false, liveIssued: true });
    const token = await tokenOf(o.orgId, invoiceId);
    await dbInternal.paymentProviderAccount.updateMany({
      where: { orgId: o.orgId },
      data: { mode: "TEST", apiKeyEnc: encryptSecret(FAKE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE), lastTestOk: true, enabled: true },
    });
    const fake = openFake();
    expect(await startCheckout(token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    expect(fake.calls).toHaveLength(0);
  });

  it("im Testmodus angelegter Link bekommt liveIssued false und erlaubt Test-Checkout; Live-Konto einschalten -> true, danach Testkonto gesperrt", async () => {
    const o = await makeOrg("Folge Test GmbH", "TEST");
    const { invoiceId, link } = await invoiceFor(o);
    expect(link).toMatchObject({ onDocument: false, liveIssued: false });
    const token = await tokenOf(o.orgId, invoiceId);
    const fake = openFake();
    expect(await startCheckout(token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "REDIRECT" });
    expect(fake.calls).toHaveLength(1);

    // Live-Schluessel hinterlegt (Verbindungstest gilt als erfolgt) und eingeschaltet.
    await dbInternal.paymentProviderAccount.updateMany({
      where: { orgId: o.orgId },
      data: { mode: "LIVE", apiKeyEnc: encryptSecret(FAKE_LIVE_KEY, PAYMENT_PROVIDER_KEY_PURPOSE), lastTestOk: true, enabled: false },
    });
    await setProviderEnabled(o.orgId, "MOLLIE", true, "tester");
    expect((await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: link!.id }, select: { liveIssued: true } })).liveIssued).toBe(true);

    await dbInternal.paymentProviderAccount.updateMany({
      where: { orgId: o.orgId },
      data: { mode: "TEST", apiKeyEnc: encryptSecret(FAKE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE), lastTestOk: true, enabled: true },
    });
    const fake2 = openFake();
    expect(await startCheckout(token, { transport: fake2.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    expect(fake2.calls).toHaveLength(0);
  });

  it("Einschalten eines Testkontos laesst liveIssued unveraendert", async () => {
    const o = await makeOrg("Folge Test Ein GmbH", "TEST");
    const { link } = await invoiceFor(o);
    await dbInternal.paymentProviderAccount.updateMany({ where: { orgId: o.orgId }, data: { enabled: false } });
    await setProviderEnabled(o.orgId, "MOLLIE", true, "tester");
    expect((await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: link!.id }, select: { liveIssued: true } })).liveIssued).toBe(false);
  });
});

describe("liveIssued bei der Ausgabe", () => {
  const issued = async (linkId: string): Promise<boolean> =>
    (await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { id: linkId }, select: { liveIssued: true } })).liveIssued;

  it("Mail und Portal im Live-Konto markieren den Link, Beleg-Ausgabe ebenfalls", async () => {
    const o = await makeOrg("Ausgabe Live GmbH", "LIVE");
    const inv = (await invoiceFor(o)) as { invoiceId: string; link: { id: string } };
    const unmark = () => dbInternal.invoicePayLink.update({ where: { id: inv.link.id }, data: { liveIssued: false } });
    const ref = { id: inv.invoiceId, status: "FINALIZED" };

    await unmark();
    expect(await mailPayLinkUrl(o.orgId, ref, 11900)).toContain("/zahlen/");
    expect(await issued(inv.link.id)).toBe(true);

    await unmark();
    expect((await portalPayPaths(o.orgId, [{ ...ref, openCents: 11900 }])).get(inv.invoiceId)).toContain("/zahlen/");
    expect(await issued(inv.link.id)).toBe(true);

    await unmark();
    await dbInternal.invoicePayLink.update({ where: { id: inv.link.id }, data: { onDocument: true } });
    expect(await documentPayLinkUrl(o.orgId, ref, 11900)).toContain("/zahlen/");
    expect(await issued(inv.link.id)).toBe(true);
  });

  it("Testkonto: Mail und Portal geben nichts aus und markieren nicht", async () => {
    const o = await makeOrg("Ausgabe Test GmbH", "TEST");
    const inv = (await invoiceFor(o)) as { invoiceId: string; link: { id: string } };
    const ref = { id: inv.invoiceId, status: "FINALIZED" };
    expect(await mailPayLinkUrl(o.orgId, ref, 11900)).toBe("");
    expect((await portalPayPaths(o.orgId, [{ ...ref, openCents: 11900 }])).size).toBe(0);
    expect(await issued(inv.link.id)).toBe(false);
  });
});

describe("Erstattung nach manueller Gegenbuchung", () => {
  const state = (objectId: string, attemptId: string, refundedCents: number): ProviderPaymentState => ({
    objectId,
    testMode: false,
    status: "PAID",
    amountCents: 11900,
    currency: "EUR",
    refundedCents,
    chargedBackCents: 0,
    paidAt: NOW,
    expiresAt: null,
    attemptId,
    paymentRef: objectId,
  });

  async function setupPaid(name: string) {
    const o = await makeOrg(name, "LIVE");
    const { invoiceId, link } = await invoiceFor(o);
    objectCounterInc();
    const objectId = `tr_Cover${String(counter).padStart(6, "0")}`;
    const attempt = await dbInternal.paymentProviderAttempt.create({
      data: { orgId: o.orgId, payLinkId: link!.id, provider: "MOLLIE", amountCents: 11900, currency: "EUR", status: "OPEN", providerObjectId: objectId, checkoutUrl: `https://www.mollie.com/checkout/select-method/${objectId}` },
      select: { id: true },
    });
    const opts = { createdBy: "webhook" as const, actor: "t", now: NOW };
    await reconcileAttempt(attempt.id, state(objectId, attempt.id, 0), opts);
    const pay = await dbInternal.payment.findFirstOrThrow({ where: { invoiceId, kind: "PAYMENT" }, select: { id: true } });
    return { o, invoiceId, objectId, attemptId: attempt.id, payId: pay.id, opts };
  }
  const reversalsOf = async (invoiceId: string) =>
    (await dbInternal.payment.findMany({ where: { invoiceId, kind: "REVERSAL" }, select: { amountCents: true }, orderBy: { createdAt: "asc" } })).map((p) => p.amountCents);

  it("gleich hohe Erstattung: keine weitere Gegenbuchung, Detail vermerkt, keine Benachrichtigung", async () => {
    const s = await setupPaid("Folge Gedeckt GmbH");
    await reversePayment(s.payId, { amountCents: 1900, reason: "Manuelle Korrektur" }, { actor: "tester", orgId: s.o.orgId, now: NOW });
    const notesBefore = await dbInternal.notification.count({ where: { orgId: s.o.orgId } });
    await reconcileAttempt(s.attemptId, state(s.objectId, s.attemptId, 1900), s.opts);
    expect(await reversalsOf(s.invoiceId)).toEqual([-1900]);
    const ev = await dbInternal.paymentProviderEvent.findMany({ where: { orgId: s.o.orgId, objectId: s.objectId }, select: { result: true, detail: true }, orderBy: { receivedAt: "asc" } });
    expect(ev.at(-1)).toMatchObject({ result: "IGNORED" });
    expect(ev.at(-1)!.detail).toContain("Erstattung bereits gegengebucht (1900 Cent)");
    expect(await dbInternal.notification.count({ where: { orgId: s.o.orgId } })).toBe(notesBefore);
  });

  it("Wiederholung desselben Zustands: keine zweite Buchung, kein zweites Ereignis", async () => {
    const s = await setupPaid("Folge Wiederholt GmbH");
    await reversePayment(s.payId, { amountCents: 1900, reason: "Manuelle Korrektur" }, { actor: "tester", orgId: s.o.orgId, now: NOW });
    await reconcileAttempt(s.attemptId, state(s.objectId, s.attemptId, 1900), s.opts);
    const count = () => dbInternal.paymentProviderEvent.count({ where: { orgId: s.o.orgId, objectId: s.objectId } });
    const before = await count();
    await reconcileAttempt(s.attemptId, state(s.objectId, s.attemptId, 1900), s.opts);
    expect(await count()).toBe(before);
    expect(await reversalsOf(s.invoiceId)).toEqual([-1900]);
  });

  it("Rueckbuchung mit manueller Gegenbuchung: Detail nennt Rueckbuchung und den Zuwachs", async () => {
    const s = await setupPaid("Folge Rueckbuchung GmbH");
    await reversePayment(s.payId, { amountCents: 1900, reason: "Manuelle Korrektur" }, { actor: "tester", orgId: s.o.orgId, now: NOW });
    await reconcileAttempt(s.attemptId, { ...state(s.objectId, s.attemptId, 0), chargedBackCents: 1900 }, s.opts);
    expect(await reversalsOf(s.invoiceId)).toEqual([-1900]);
    const ev = await dbInternal.paymentProviderEvent.findMany({ where: { orgId: s.o.orgId, objectId: s.objectId }, select: { detail: true }, orderBy: { receivedAt: "asc" } });
    expect(ev.at(-1)!.detail).toContain("Rueckbuchung bereits gegengebucht (1900 Cent)");
  });

  it("hoehere Erstattung: genau die Differenz wird gegengebucht", async () => {
    const s = await setupPaid("Folge Differenz GmbH");
    await reversePayment(s.payId, { amountCents: 1900, reason: "Manuelle Korrektur" }, { actor: "tester", orgId: s.o.orgId, now: NOW });
    await reconcileAttempt(s.attemptId, state(s.objectId, s.attemptId, 5000), s.opts);
    expect(await reversalsOf(s.invoiceId)).toEqual([-1900, -3100]);
  });
});

function objectCounterInc(): void {
  counter += 1;
}

describe("Festschreiben ohne APP_BASE_URL", () => {
  it("Link ohne Beleg-Eintrag und genau eine Meldung je Tag", async () => {
    const o = await makeOrg("Folge OhneUrl GmbH", "LIVE");
    delete process.env.APP_BASE_URL;
    try {
      const a = await invoiceFor(o);
      expect(a.link).toMatchObject({ onDocument: false });
      const b = await invoiceFor(o);
      expect(b.link).toMatchObject({ onDocument: false });
    } finally {
      process.env.APP_BASE_URL = BASE;
    }
    const notes = await dbInternal.notification.findMany({ where: { orgId: o.orgId, type: "ONLINE_PAYMENT_ISSUE" }, select: { title: true, dedupeKey: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("APP_BASE_URL fehlt");
    expect(notes[0]!.dedupeKey).toBe(`online:nobaseurl:${YEAR}-03-10`);
  });

  it("am Folgetag neue Meldung; Text unabhaengig vom aktuellen Stand der URL", async () => {
    const o = await makeOrg("Folge Zweitag GmbH", "LIVE");
    delete process.env.APP_BASE_URL;
    try {
      await invoiceFor(o);
      await invoiceFor(o, new Date(`${YEAR}-03-11T10:00:00.000Z`));
    } finally {
      process.env.APP_BASE_URL = BASE;
    }
    const notes = await dbInternal.notification.findMany({ where: { orgId: o.orgId, type: "ONLINE_PAYMENT_ISSUE" }, select: { dedupeKey: true, body: true } });
    expect(notes.map((n) => n.dedupeKey).sort()).toEqual([`online:nobaseurl:${YEAR}-03-10`, `online:nobaseurl:${YEAR}-03-11`]);
    expect(notes[0]!.body).toContain("erscheint er erst, wenn APP_BASE_URL gesetzt ist");
  });

  it("mit APP_BASE_URL keine Meldung", async () => {
    const o = await makeOrg("Folge MitUrl GmbH", "LIVE");
    const a = await invoiceFor(o);
    expect(a.link).toMatchObject({ onDocument: true });
    expect(await dbInternal.notification.count({ where: { orgId: o.orgId } })).toBe(0);
  });
});
