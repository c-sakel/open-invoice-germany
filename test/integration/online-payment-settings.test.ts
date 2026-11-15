/** Online-Zahlung: Einstellungen, Zugang, Einschalten, Verbindungstest (nur Fake-Transport, nie Netz). */
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbInternal } from "@/lib/db";
import { decryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE } from "@/lib/crypto/secrets";
import {
  loadOnlinePaymentSettings,
  loadProviderSecret,
  saveOnlinePaymentSettings,
  saveProviderOptions,
  setProviderApiKey,
  setProviderEnabled,
  testProviderConnection,
} from "@/domain/online-payment/settings";
import { OnlinePaymentError } from "@/domain/online-payment/errors";
import { FAKE_LIVE_KEY, FAKE_TEST_KEY, createMollieFake, mollieFixture } from "../helpers/mollie-fake";

let orgId: string;
let otherOrgId: string;
let httpsSpy: ReturnType<typeof vi.spyOn>;
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  const base = { addressLine1: "Weg 1", postalCode: "21339", city: "Lüneburg" };
  orgId = (await dbInternal.organization.create({ data: { legalName: "Zahl Settings GmbH", ...base } })).id;
  otherOrgId = (await dbInternal.organization.create({ data: { legalName: "Fremd Settings GmbH", ...base } })).id;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});
const resetCooldown = () => dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { lastTestAt: null } });
beforeEach(async () => {
  await resetCooldown();
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = "https://rechnung.example.org";
  httpsSpy = vi.spyOn(https, "request");
});
afterEach(() => {
  expect(httpsSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const okFake = () => createMollieFake({ "GET /methods": { status: 200, text: mollieFixture("methods") } });

describe("Einstellungen", () => {
  it("Defaults ohne Zeile, Teil-Update und Laden", async () => {
    const v0 = await loadOnlinePaymentSettings(orgId);
    expect(v0).toMatchObject({ defaultProvider: "NONE", showOnPdf: true, showInMail: true, showInPortal: true });
    expect(v0.accounts).toHaveLength(1);
    expect(v0.accounts[0]).toMatchObject({ provider: "MOLLIE", enabled: false, hasApiKey: false, currencies: ["EUR"] });
    const v1 = await saveOnlinePaymentSettings(orgId, { defaultProvider: "MOLLIE", showInPortal: false }, "tester");
    expect(v1).toMatchObject({ defaultProvider: "MOLLIE", showOnPdf: true, showInPortal: false });
    const v2 = await saveOnlinePaymentSettings(orgId, { showOnPdf: false }, "tester");
    expect(v2).toMatchObject({ defaultProvider: "MOLLIE", showOnPdf: false, showInPortal: false });
    await expect(saveOnlinePaymentSettings(orgId, { defaultProvider: "STRIPE" }, "tester")).rejects.toThrow();
    // Org-Scope: die andere Organisation bleibt unberuehrt.
    expect((await loadOnlinePaymentSettings(otherOrgId)).defaultProvider).toBe("NONE");
  });
});

describe("Zugang", () => {
  it("Schluessel nur verschluesselt, View mit letzten 4 Zeichen, Modus aus dem Praefix", async () => {
    const v = await setProviderApiKey(orgId, "MOLLIE", FAKE_TEST_KEY, "tester");
    expect(v.accounts[0]).toMatchObject({ hasApiKey: true, apiKeyLast4: FAKE_TEST_KEY.slice(-4), mode: "TEST", enabled: false, lastTestOk: null });
    const row = await dbInternal.paymentProviderAccount.findUniqueOrThrow({
      where: { orgId_provider: { orgId, provider: "MOLLIE" } },
      select: { apiKeyEnc: true, webhookPathId: true },
    });
    expect(row.apiKeyEnc).not.toContain(FAKE_TEST_KEY);
    expect(decryptSecret(row.apiKeyEnc ?? "", PAYMENT_PROVIDER_KEY_PURPOSE)).toBe(FAKE_TEST_KEY);
    expect(row.webhookPathId.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(v)).not.toContain(FAKE_TEST_KEY);
    const secret = await loadProviderSecret(orgId, "MOLLIE");
    expect(secret).toMatchObject({ key: FAKE_TEST_KEY, mode: "TEST", enabled: false });
    expect(await loadProviderSecret(otherOrgId, "MOLLIE")).toBeNull();
  });

  it("ungueltiges Schluesselformat wird abgelehnt", async () => {
    await expect(setProviderApiKey(orgId, "MOLLIE", "ohne-praefix-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "tester")).rejects.toThrow();
  });

  it("Einschalten: Test fehlt -> Fehler; Test ok -> erlaubt; Schluesselwechsel setzt Test zurueck", async () => {
    await expect(setProviderEnabled(orgId, "MOLLIE", true, "tester")).rejects.toMatchObject({ code: "NOT_TESTED" });
    const res = await testProviderConnection(orgId, "MOLLIE", "tester", { transport: okFake().transport });
    expect(res.ok).toBe(true);
    expect(res.methods.length).toBeGreaterThan(0);
    const on = await setProviderEnabled(orgId, "MOLLIE", true, "tester");
    expect(on.accounts[0]).toMatchObject({ enabled: true, lastTestOk: true });
    const changed = await setProviderApiKey(orgId, "MOLLIE", FAKE_LIVE_KEY, "tester");
    expect(changed.accounts[0]).toMatchObject({ mode: "LIVE", enabled: false, lastTestOk: null, lastTestAt: null });
    await expect(setProviderEnabled(orgId, "MOLLIE", true, "tester")).rejects.toMatchObject({ code: "NOT_TESTED" });
  });

  it("Schluesselwechsel waehrend des Verbindungstests: Ergebnis wird verworfen", async () => {
    const fake = okFake();
    const slow = {
      ...fake,
      transport: async (...args: Parameters<typeof fake.transport>) => {
        await setProviderApiKey(orgId, "MOLLIE", FAKE_LIVE_KEY, "tester");
        return fake.transport(...args);
      },
    };
    const res = await testProviderConnection(orgId, "MOLLIE", "tester", { transport: slow.transport });
    expect(res.ok).toBe(false);
    const row = await dbInternal.paymentProviderAccount.findFirstOrThrow({ where: { orgId, provider: "MOLLIE" }, select: { lastTestOk: true, enabled: true } });
    expect(row).toMatchObject({ lastTestOk: null, enabled: false });
  });

  it("Einschalten ohne APP_BASE_URL und ohne Schluessel schlaegt fehl", async () => {
    await testProviderConnection(orgId, "MOLLIE", "tester", { transport: okFake().transport });
    delete process.env.APP_BASE_URL;
    await expect(setProviderEnabled(orgId, "MOLLIE", true, "tester")).rejects.toMatchObject({ code: "NO_BASE_URL" });
    process.env.APP_BASE_URL = "https://rechnung.example.org";
    await expect(setProviderEnabled(otherOrgId, "MOLLIE", true, "tester")).rejects.toMatchObject({ code: "NO_KEY" });
  });

  it("Verbindungstest mit 401: fester Fehlertext, lastTestOk false", async () => {
    const fake = createMollieFake({ "GET /methods": { status: 401, text: mollieFixture("error-401") } });
    const res = await testProviderConnection(orgId, "MOLLIE", "tester", { transport: fake.transport });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("HTTP 401");
    expect(res.error).not.toContain("Missing authentication");
    const v = await loadOnlinePaymentSettings(orgId);
    expect(v.accounts[0]).toMatchObject({ lastTestOk: false });
    await resetCooldown();
    // Der Standard-Transport ist unter Vitest gesperrt -> fester Text, kein Netz.
    const blocked = await testProviderConnection(orgId, "MOLLIE", "tester");
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("Zahlungsanbieter nicht erreichbar.");
  });

  it("Verbindungstest: Mindestabstand wird atomar beansprucht, nur ein gleichzeitiger Aufruf laeuft", async () => {
    await setProviderApiKey(orgId, "MOLLIE", FAKE_TEST_KEY, "tester");
    await resetCooldown();
    const results = await Promise.allSettled([1, 2, 3].map(() => testProviderConnection(orgId, "MOLLIE", "tester", { transport: okFake().transport })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("Optionen: Methoden und Waehrungen speichern, ungueltige Eingaben ablehnen", async () => {
    const v = await saveProviderOptions(orgId, "MOLLIE", { allowedMethods: ["creditcard", "ideal"], currencies: ["EUR", "CHF"] }, "tester");
    expect(v.accounts[0]).toMatchObject({ allowedMethods: ["creditcard", "ideal"], currencies: ["EUR", "CHF"] });
    const v2 = await saveProviderOptions(orgId, "MOLLIE", { allowedMethods: null }, "tester");
    expect(v2.accounts[0]).toMatchObject({ allowedMethods: null, currencies: ["EUR", "CHF"] });
    await expect(saveProviderOptions(orgId, "MOLLIE", { currencies: ["JPY"] }, "tester")).rejects.toThrow();
  });

  it("Schluessel entfernen schaltet aus und loescht den Schluessel", async () => {
    await testProviderConnection(orgId, "MOLLIE", "tester", { transport: okFake().transport });
    await setProviderEnabled(orgId, "MOLLIE", true, "tester");
    const v = await setProviderApiKey(orgId, "MOLLIE", null, "tester");
    expect(v.accounts[0]).toMatchObject({ enabled: false, hasApiKey: false, apiKeyLast4: null, mode: null });
    expect(await loadProviderSecret(orgId, "MOLLIE")).toBeNull();
  });
});

describe("Geheimnisse", () => {
  it("der Schluessel steht in keiner Protokollzeile und in keiner Konsolenausgabe", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    await setProviderApiKey(orgId, "MOLLIE", FAKE_TEST_KEY, "tester");
    await testProviderConnection(orgId, "MOLLIE", "tester", { transport: okFake().transport });
    await resetCooldown();
    await testProviderConnection(orgId, "MOLLIE", "tester").catch(() => undefined);
    await setProviderApiKey(orgId, "MOLLIE", null, "tester");
    const needle = FAKE_TEST_KEY.slice(5);
    const activity = await dbInternal.activityLog.findMany({ where: { orgId }, select: { dataJson: true } });
    const changes = await dbInternal.changeLog.findMany({ where: { orgId }, select: { diffJson: true } });
    const notes = await dbInternal.notification.findMany({ where: { orgId }, select: { title: true, body: true } });
    expect(JSON.stringify([activity, changes, notes])).not.toContain(needle);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(needle);
    expect(OnlinePaymentError).toBeDefined();
  });
});
