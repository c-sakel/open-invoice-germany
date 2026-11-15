/** Online-Zahlung (Stripe): Zugang, Signaturschluessel, Einschalten, Verbindungstest (nur Fake-Transport, nie Netz). */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { decryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE, PAYMENT_WEBHOOK_SECRET_PURPOSE } from "@/lib/crypto/secrets";
import {
  loadOnlinePaymentSettings,
  loadProviderSecret,
  loadWebhookSigningSecret,
  revealWebhookUrl,
  saveProviderOptions,
  setProviderApiKey,
  setProviderEnabled,
  setProviderWebhookSecret,
  testProviderConnection,
} from "@/domain/online-payment/settings";
import { OnlinePaymentError } from "@/domain/online-payment/errors";
import { parseOnlinePaymentSettingsInput } from "@/domain/online-payment/views";
import { createMollieFake, FAKE_TEST_KEY, mollieFixture } from "../helpers/mollie-fake";
import {
  FAKE_STRIPE_LIVE_KEY,
  FAKE_STRIPE_PUBLISHABLE_KEY,
  FAKE_STRIPE_RESTRICTED_LIVE_KEY,
  FAKE_STRIPE_SIGNING_SECRET,
  FAKE_STRIPE_TEST_KEY,
  createStripeFake,
  stripeFixture,
} from "../helpers/stripe-fake";

let orgId: string;
let httpsSpy: ReturnType<typeof vi.spyOn>;
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  orgId = (await dbInternal.organization.create({ data: { legalName: "Stripe Settings GmbH", addressLine1: "Weg 1", postalCode: "21339", city: "Lüneburg" } })).id;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});
beforeEach(async () => {
  await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { lastTestAt: null } });
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = "https://rechnung.example.org";
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const stripeAccount = async () => (await loadOnlinePaymentSettings(orgId)).accounts.find((a) => a.provider === "STRIPE")!;
const okFake = () => createStripeFake({ "GET /checkout/sessions": { status: 200, text: JSON.stringify({ object: "list", data: [] }) } });

describe("Stripe-Zugang", () => {
  it("Schluessel sk/rk, test/live -> Modus; pk_ und whsec_ als API-Schluessel -> INVALID_KEY", async () => {
    for (const [key, mode] of [
      [FAKE_STRIPE_TEST_KEY, "TEST"],
      [FAKE_STRIPE_LIVE_KEY, "LIVE"],
      [FAKE_STRIPE_RESTRICTED_LIVE_KEY, "LIVE"],
    ] as const) {
      const v = await setProviderApiKey(orgId, "STRIPE", key, "tester");
      expect(v.accounts.find((a) => a.provider === "STRIPE")).toMatchObject({ mode, hasApiKey: true, enabled: false, apiKeyLast4: key.slice(-4) });
      const row = await dbInternal.paymentProviderAccount.findUnique({ where: { orgId_provider: { orgId, provider: "STRIPE" } }, select: { apiKeyEnc: true } });
      expect(row?.apiKeyEnc).not.toContain(key);
      expect(decryptSecret(row!.apiKeyEnc!, PAYMENT_PROVIDER_KEY_PURPOSE)).toBe(key);
    }
    await expect(setProviderApiKey(orgId, "STRIPE", FAKE_STRIPE_PUBLISHABLE_KEY, "tester")).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(setProviderApiKey(orgId, "STRIPE", FAKE_STRIPE_SIGNING_SECRET + "xxxxxxxxxx", "tester")).rejects.toMatchObject({ code: "INVALID_KEY" });
    // Mollie-Schluessel fuer Stripe unzulaessig.
    await expect(setProviderApiKey(orgId, "STRIPE", FAKE_TEST_KEY, "tester")).rejects.toMatchObject({ code: "INVALID_KEY" });
  });

  it("Signaturschluessel: nur verschluesselt, View-Flags, Formatfehler, nur fuer signierende Anbieter", async () => {
    expect((await stripeAccount()).requiresWebhookSecret).toBe(true);
    const v = await setProviderWebhookSecret(orgId, "STRIPE", FAKE_STRIPE_SIGNING_SECRET, "tester");
    expect(v.accounts.find((a) => a.provider === "STRIPE")).toMatchObject({ hasWebhookSecret: true, requiresWebhookSecret: true });
    expect(JSON.stringify(v)).not.toContain(FAKE_STRIPE_SIGNING_SECRET.slice(6));
    const row = await dbInternal.paymentProviderAccount.findUnique({ where: { orgId_provider: { orgId, provider: "STRIPE" } }, select: { webhookSecretEnc: true } });
    expect(row?.webhookSecretEnc).not.toBeNull();
    expect(row?.webhookSecretEnc).not.toContain(FAKE_STRIPE_SIGNING_SECRET);
    expect(decryptSecret(row!.webhookSecretEnc!, PAYMENT_WEBHOOK_SECRET_PURPOSE)).toBe(FAKE_STRIPE_SIGNING_SECRET);
    expect(await loadWebhookSigningSecret(orgId, "STRIPE")).toBe(FAKE_STRIPE_SIGNING_SECRET);
    await expect(setProviderWebhookSecret(orgId, "STRIPE", "whsec_kurz", "tester")).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(setProviderWebhookSecret(orgId, "STRIPE", FAKE_STRIPE_TEST_KEY, "tester")).rejects.toMatchObject({ code: "INVALID_KEY" });
    await expect(setProviderWebhookSecret(orgId, "MOLLIE", FAKE_STRIPE_SIGNING_SECRET, "tester")).rejects.toMatchObject({ code: "INVALID_KEY" });
    // Klartext des API-Schluessels ist mit dem Zweck des Signaturschluessels nicht lesbar.
    const keyRow = await loadProviderSecret(orgId, "STRIPE");
    expect(() => decryptSecret(keyRow!.keyEnc, PAYMENT_WEBHOOK_SECRET_PURPOSE)).toThrow();
  });

  it("Einschalten ohne Signaturschluessel -> NO_WEBHOOK_SECRET; mit Schluessel und Test ok erlaubt; Wechsel und Entfernen schalten aus", async () => {
    const org2 = (await dbInternal.organization.create({ data: { legalName: "Stripe Einschalten GmbH", addressLine1: "Weg 1", postalCode: "21339", city: "Lüneburg" } })).id;
    await setProviderApiKey(org2, "STRIPE", FAKE_STRIPE_TEST_KEY, "tester");
    expect((await testProviderConnection(org2, "STRIPE", "tester", { transport: okFake().transport })).ok).toBe(true);
    await expect(setProviderEnabled(org2, "STRIPE", true, "tester")).rejects.toMatchObject({ code: "NO_WEBHOOK_SECRET", message: "Zum Einschalten fehlt der Signaturschluessel." });
    await setProviderWebhookSecret(org2, "STRIPE", FAKE_STRIPE_SIGNING_SECRET, "tester");
    expect((await setProviderEnabled(org2, "STRIPE", true, "tester")).accounts.find((a) => a.provider === "STRIPE")?.enabled).toBe(true);
    // Wechsel des Signaturschluessels schaltet aus (wie beim API-Schluessel)
    const other = ["whsec", "FAKE" + "c".repeat(28)].join("_");
    expect((await setProviderWebhookSecret(org2, "STRIPE", other, "tester")).accounts.find((a) => a.provider === "STRIPE")).toMatchObject({ enabled: false, hasWebhookSecret: true });
    await setProviderEnabled(org2, "STRIPE", true, "tester");
    const removed = await setProviderWebhookSecret(org2, "STRIPE", null, "tester");
    expect(removed.accounts.find((a) => a.provider === "STRIPE")).toMatchObject({ enabled: false, hasWebhookSecret: false });
    expect(await loadWebhookSigningSecret(org2, "STRIPE")).toBeNull();
  });

  it("Mollie verlangt weiterhin keinen Signaturschluessel", async () => {
    const org2 = (await dbInternal.organization.create({ data: { legalName: "Mollie Einschalten GmbH", addressLine1: "Weg 1", postalCode: "21339", city: "Lüneburg" } })).id;
    await setProviderApiKey(org2, "MOLLIE", FAKE_TEST_KEY, "tester");
    await testProviderConnection(org2, "MOLLIE", "tester", { transport: createMollieFake({ "GET /methods": { status: 200, text: mollieFixture("methods") } }).transport });
    const v = await setProviderEnabled(org2, "MOLLIE", true, "tester");
    expect(v.accounts.find((a) => a.provider === "MOLLIE")).toMatchObject({ enabled: true, requiresWebhookSecret: false, hasWebhookSecret: false });
  });

  it("Verbindungstest: 200 ok, 401 fester Fehlertext, Cooldown wie bei Mollie", async () => {
    await setProviderApiKey(orgId, "STRIPE", FAKE_STRIPE_TEST_KEY, "tester");
    const bad = createStripeFake({ "GET /checkout/sessions": { status: 401, text: stripeFixture("error-401") } });
    const r401 = await testProviderConnection(orgId, "STRIPE", "tester", { transport: bad.transport });
    expect(r401.ok).toBe(false);
    expect(r401.error).not.toContain("****");
    expect((await stripeAccount()).lastTestOk).toBe(false);
    await expect(testProviderConnection(orgId, "STRIPE", "tester", { transport: okFake().transport })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { lastTestAt: null } });
    const ok = okFake();
    expect((await testProviderConnection(orgId, "STRIPE", "tester", { transport: ok.transport })).ok).toBe(true);
    expect(ok.calls).toHaveLength(1);
    expect((await stripeAccount()).lastTestOk).toBe(true);
  });

  it("Methoden: card/sepa_debit ok, creditcard -> INVALID_METHOD; Mollie unbeschraenkt", async () => {
    const v = await saveProviderOptions(orgId, "STRIPE", { allowedMethods: ["card", "sepa_debit"] }, "tester");
    expect(v.accounts.find((a) => a.provider === "STRIPE")?.allowedMethods).toEqual(["card", "sepa_debit"]);
    await expect(saveProviderOptions(orgId, "STRIPE", { allowedMethods: ["creditcard"] }, "tester")).rejects.toMatchObject({ code: "INVALID_METHOD" });
    await saveProviderOptions(orgId, "MOLLIE", { allowedMethods: ["creditcard"] }, "tester");
  });

  it("revealWebhookUrl = <APP_BASE_URL>/api/public/payments/stripe/<webhookPathId>; ohne APP_BASE_URL null; Signaturschluessel nicht ueber REST/MCP-Eingabe", async () => {
    const row = await dbInternal.paymentProviderAccount.findUnique({ where: { orgId_provider: { orgId, provider: "STRIPE" } }, select: { webhookPathId: true } });
    expect(await revealWebhookUrl(orgId, "STRIPE")).toBe(`https://rechnung.example.org/api/public/payments/stripe/${row!.webhookPathId}`);
    delete process.env.APP_BASE_URL;
    expect(await revealWebhookUrl(orgId, "STRIPE")).toBeNull();
    expect(() => parseOnlinePaymentSettingsInput({ webhookSecret: "x" })).toThrow();
  });

  it("Default-Anbieter STRIPE wird gelesen", async () => {
    await dbInternal.paymentProviderSettings.upsert({ where: { orgId }, create: { orgId, defaultProvider: "STRIPE" }, update: { defaultProvider: "STRIPE" } });
    expect((await loadOnlinePaymentSettings(orgId)).defaultProvider).toBe("STRIPE");
  });
});

describe("Geheimnisse", () => {
  it("API-Schluessel und Signaturschluessel stehen in keiner Protokoll-, Aenderungs-, Benachrichtigungszeile und keiner Konsolenausgabe", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const org2 = (await dbInternal.organization.create({ data: { legalName: "Stripe Geheim GmbH", addressLine1: "Weg 1", postalCode: "21339", city: "Lüneburg" } })).id;
    await setProviderApiKey(org2, "STRIPE", FAKE_STRIPE_LIVE_KEY, "tester");
    await setProviderWebhookSecret(org2, "STRIPE", FAKE_STRIPE_SIGNING_SECRET, "tester");
    await testProviderConnection(org2, "STRIPE", "tester", { transport: createStripeFake({ "GET /checkout/sessions": { status: 401, text: stripeFixture("error-401") } }).transport });
    await setProviderWebhookSecret(org2, "STRIPE", null, "tester");
    await setProviderApiKey(org2, "STRIPE", null, "tester");
    const activity = await dbInternal.activityLog.findMany({ where: { orgId: org2 }, select: { dataJson: true } });
    const changes = await dbInternal.changeLog.findMany({ where: { orgId: org2 }, select: { diffJson: true } });
    const notes = await dbInternal.notification.findMany({ where: { orgId: org2 }, select: { title: true, body: true } });
    const all = JSON.stringify([activity, changes, notes, spies.map((s) => s.mock.calls)]);
    expect(all).not.toContain(FAKE_STRIPE_LIVE_KEY.slice(8));
    expect(all).not.toContain(FAKE_STRIPE_SIGNING_SECRET.slice(6));
    expect(activity.map((a) => a.dataJson).join()).toContain("webhookSecretRemoved");
    expect(OnlinePaymentError).toBeDefined();
  });
});

describe("Live-Kennzeichen beim Einschalten", () => {
  it("setzt liveIssued fuer bestehende Links im Livebetrieb (erster und zweiter Durchlauf nach dem Commit)", async () => {
    const org2 = (await dbInternal.organization.create({ data: { legalName: "Stripe Live GmbH", addressLine1: "Weg 1", postalCode: "21339", city: "Lüneburg" } })).id;
    await setProviderApiKey(org2, "STRIPE", FAKE_STRIPE_LIVE_KEY, "tester");
    await setProviderWebhookSecret(org2, "STRIPE", FAKE_STRIPE_SIGNING_SECRET, "tester");
    await testProviderConnection(org2, "STRIPE", "tester", { transport: okFake().transport });
    const mkLink = async (suffix: string) => {
      const cust = await dbInternal.customer.create({ data: { orgId: org2, name: `K ${suffix}`, addressLine1: "A 1", postalCode: "10115", city: "Berlin", type: "BUSINESS" } });
      const inv = await dbInternal.invoice.create({
        data: { orgId: org2, customerId: cust.id, status: "DRAFT", type: "INVOICE", issueDate: new Date("2220-03-01"), currency: "EUR" },
        select: { id: true },
      });
      return dbInternal.invoicePayLink.create({
        data: { orgId: org2, invoiceId: inv.id, provider: "STRIPE", tokenHash: `h-${org2}-${suffix}`, tokenEnc: "x", liveIssued: false, createdBy: "test" },
        select: { id: true },
      });
    };
    const before = await mkLink("a");
    // Link, der zwischen Commit und zweitem Durchlauf (ohne Organisationssperre) mit liveIssued=false entsteht:
    // nur der zweite Durchlauf erfasst ihn. Der Hook greift beim Lesen des Kontos nach dem Commit.
    let late: { id: string } | null = null;
    const realFind = dbInternal.paymentProviderAccount.findUnique.bind(dbInternal.paymentProviderAccount);
    const hook = async (args: unknown) => {
      late ??= await mkLink("b");
      return realFind(args as never);
    };
    const spy = vi.spyOn(dbInternal.paymentProviderAccount, "findUnique").mockImplementation(hook as unknown as typeof realFind);
    await setProviderEnabled(org2, "STRIPE", true, "tester");
    spy.mockRestore();
    expect(late).not.toBeNull();
    expect((await dbInternal.invoicePayLink.findUnique({ where: { id: before.id }, select: { liveIssued: true } }))?.liveIssued).toBe(true);
    expect((await dbInternal.invoicePayLink.findUnique({ where: { id: late!.id }, select: { liveIssued: true } }))?.liveIssued).toBe(true);
    // Testkonto: kein Durchlauf, Links bleiben unveraendert.
    await setProviderApiKey(org2, "STRIPE", FAKE_STRIPE_TEST_KEY, "tester");
    const test = await mkLink("c");
    await testProviderConnection(org2, "STRIPE", "tester", { transport: okFake().transport });
    await setProviderEnabled(org2, "STRIPE", true, "tester");
    expect((await dbInternal.invoicePayLink.findUnique({ where: { id: test.id }, select: { liveIssued: true } }))?.liveIssued).toBe(false);
  });
});
