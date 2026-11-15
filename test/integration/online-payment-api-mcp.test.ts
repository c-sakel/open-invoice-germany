/**
 * REST und MCP der Online-Zahlung (Fake-Transport, kein Netz). Testjahr 2218.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const orgStore: { id: string | null } = vi.hoisted(() => ({ id: null }));
vi.mock("@/lib/org", () => ({
  getActiveOrg: async () => {
    if (!orgStore.id) throw new Error("Test-Org noch nicht gesetzt.");
    return { id: orgStore.id };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getCurrentUserId: async () => "tester" }));
const fake = vi.hoisted(() => ({ handler: null as null | ((req: { method: string; url: string }) => { status: number; text: string }) }));
vi.mock("@/lib/payment/transport", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/payment/transport")>();
  return {
    ...orig,
    defaultPaymentTransport: () => async (req: { method: string; url: string }) => {
      if (!fake.handler) throw new Error("kein Fake gesetzt");
      return fake.handler(req);
    },
  };
});

import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE, PAYMENT_WEBHOOK_SECRET_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createApiKey } from "@/domain/api-key/create";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { resetRateLimits } from "@/lib/rate-limit";
import { server } from "@/mcp/server";
import { createInvoiceSchema } from "@/schemas";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/v1/Settings/onlinePayment/route";
import { POST as testPost } from "@/app/api/v1/Settings/onlinePayment/[provider]/test/route";
import { GET as linkGet, POST as linkPost } from "@/app/api/v1/Invoice/[id]/payLink/route";
import { POST as disablePost } from "@/app/api/v1/Invoice/[id]/payLink/disable/route";
import { POST as refreshPost } from "@/app/api/v1/Invoice/[id]/payLink/refresh/route";
import { PATCH as contactPatch } from "@/app/api/v1/Contact/[id]/route";
import { mollieFixture, FAKE_TEST_KEY } from "../helpers/mollie-fake";
import { FAKE_STRIPE_LIVE_KEY, FAKE_STRIPE_SIGNING_SECRET } from "../helpers/stripe-fake";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type Handler = (a: Record<string, unknown>) => Promise<ToolResult>;
const tools = () => (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const tool = tools()[name];
  if (!tool) throw new Error(`MCP-Tool "${name}" ist nicht registriert.`);
  return tool.handler(args);
}

const NOW = new Date("2218-03-10T10:00:00.000Z");
const BASE = "https://rechnung.example.test";

/** Der Verbindungstest hat einen Mindestabstand; Tests, die ihn mehrfach aufrufen, setzen ihn zurueck. */
async function clearTestCooldown(): Promise<void> {
  await dbInternal.paymentProviderAccount.updateMany({ data: { lastTestAt: null } });
}
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;

let orgId: string;
let customerId: string;
let linkedId: string; // mit Link
let linkedNumber: string;
let plainId: string; // ohne Link festgeschrieben
let creditNoteId: string;
let cancelledId: string;
let foreignInvoiceToken: string;
let adminToken: string;
let writeToken: string;
let readToken: string;
let draftId: string;

function req(url: string, token: string, method = "GET", body?: unknown) {
  const headers = new Headers({ authorization: `Bearer ${token}`, host: "rechnung.example.test" });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const pp = (provider: string) => ({ params: Promise.resolve({ provider }) });
const INV = (id: string, tail = "") => `${BASE}/api/v1/Invoice/${id}/payLink${tail}`;
const SETTINGS = `${BASE}/api/v1/Settings/onlinePayment`;

async function newOrg(name: string) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  await ensureOrgMasterdata(dbInternal, org.id);
  await saveDocumentSettings(org.id, { viesCheckEnabled: false });
  const tag = org.id.slice(-6);
  for (const [docType, prefix] of [["INVOICE", "AM18"], ["CREDIT_NOTE", "AG18"]] as const) {
    await dbInternal.numberRange.upsert({
      where: { orgId_docType_year: { orgId: org.id, docType, year: 2218 } },
      create: { orgId: org.id, docType, year: 2218, currentValue: 0, prefix: `${prefix}-${tag}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
      update: { currentValue: 0, prefix: `${prefix}-${tag}-`, isActive: true },
    });
    await dbInternal.numberRange.updateMany({ where: { orgId: org.id, docType, year: { not: 2218 } }, data: { isActive: false } });
  }
  return org.id;
}

async function draft(org: string, customer: string) {
  return createDraftInvoice(
    org,
    createInvoiceSchema.parse({
      customerId: customer,
      issueDate: NOW,
      deliveryDate: new Date("2218-03-05"),
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: NOW },
  );
}

beforeAll(async () => {
  process.env.AUTH_SECRET = "test-auth-secret-mindestens-16-zeichen";
  process.env.APP_BASE_URL = BASE;
  orgId = await newOrg("Online API GmbH");
  orgStore.id = orgId;
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "MOLLIE" } });
  await dbInternal.paymentProviderAccount.create({
    data: { orgId, provider: "MOLLIE", enabled: true, mode: "TEST", apiKeyEnc: encryptSecret(FAKE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE), webhookPathId: `wh-${orgId}`, lastTestOk: true },
  });
  customerId = (await dbInternal.customer.create({ data: { orgId, name: "API Kunde", addressLine1: "Weg 1", postalCode: "20095", city: "Hamburg" } })).id;
  const a = await finalizeInvoice((await draft(orgId, customerId)).id, { now: NOW });
  linkedId = a.id;
  linkedNumber = a.number ?? "";
  const toCancel = await finalizeInvoice((await draft(orgId, customerId)).id, { now: NOW });
  cancelledId = toCancel.id;
  creditNoteId = (await cancelInvoice(cancelledId, { orgId, now: NOW })).creditNote.id;
  // Ohne eingeschaltete Anbindung festgeschrieben -> kein Link.
  await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { enabled: false } });
  plainId = (await finalizeInvoice((await draft(orgId, customerId)).id, { now: NOW })).id;
  draftId = (await draft(orgId, customerId)).id;
  await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { enabled: true } });

  const foreign = await newOrg("Fremd Online GmbH");
  const fc = await dbInternal.customer.create({ data: { orgId: foreign, name: "Fremdkunde", addressLine1: "Weg 1", postalCode: "20095", city: "Hamburg" } });
  void fc;
  foreignInvoiceToken = (await createApiKey(foreign, { name: "f", scopes: ["read", "write", "admin"] })).token;

  adminToken = (await createApiKey(orgId, { name: "a", scopes: ["read", "write", "admin"] })).token;
  writeToken = (await createApiKey(orgId, { name: "w", scopes: ["read", "write"] })).token;
  readToken = (await createApiKey(orgId, { name: "r", scopes: ["read"] })).token;
});

afterAll(() => {
  if (prevSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = prevSecret;
  if (prevBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevBase;
});

beforeEach(() => {
  resetRateLimits();
  fake.handler = null;
});

describe("REST Einstellungen", () => {
  it("GET liefert nie einen Schluessel, nur hasApiKey/mode/letzten Test; Scope write -> 403", async () => {
    const res = await settingsGet(req(SETTINGS, adminToken));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(FAKE_TEST_KEY);
    expect(text).not.toContain("apiKeyLast4");
    expect(text).not.toContain("webhook");
    const body = JSON.parse(text) as { data: { defaultProvider: string; accounts: Array<{ hasApiKey: boolean; mode: string; lastTestOk: boolean }> } };
    expect(body.data.defaultProvider).toBe("MOLLIE");
    expect(body.data.accounts[0]).toMatchObject({ hasApiKey: true, mode: "TEST", lastTestOk: true });
    expect((await settingsGet(req(SETTINGS, writeToken))).status).toBe(403);
    expect((await settingsPut(req(SETTINGS, writeToken, "PUT", { showOnPdf: false }))).status).toBe(403);
  });

  it("PUT aendert nur Anzeigeoptionen; Schluessel/Einschalter/Methoden/Waehrungen -> 400", async () => {
    for (const bad of [{ apiKey: "test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }, { enabled: false }, { allowedMethods: ["ideal"] }, { currencies: ["EUR"] }, { unbekannt: 1 }, {}]) {
      expect((await settingsPut(req(SETTINGS, adminToken, "PUT", bad))).status).toBe(400);
    }
    const bodyText = await (await settingsPut(req(SETTINGS, adminToken, "PUT", { apiKey: "test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }))).text();
    expect(bodyText).not.toContain("test_xxxx");
    const ok = await settingsPut(req(SETTINGS, adminToken, "PUT", { showInPortal: false }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { showInPortal: boolean; showOnPdf: boolean } }).data).toMatchObject({ showInPortal: false, showOnPdf: true });
    await settingsPut(req(SETTINGS, adminToken, "PUT", { showInPortal: true }));
    const account = await dbInternal.paymentProviderAccount.findFirst({ where: { orgId }, select: { enabled: true } });
    expect(account?.enabled).toBe(true);
  });

  it("Verbindungstest: ok, 401 mit festem Text, ohne Schluessel 422, falscher Anbieter 400, Scope write 403", async () => {
    fake.handler = () => ({ status: 200, text: mollieFixture("methods") });
    await clearTestCooldown();
    const res = await testPost(req(`${SETTINGS}/MOLLIE/test`, adminToken, "POST"), pp("MOLLIE"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { ok: boolean; methods: string[] } }).data).toMatchObject({ ok: true, methods: ["ideal", "creditcard"] });
    fake.handler = () => ({ status: 401, text: mollieFixture("error-401") });
    await clearTestCooldown();
    const bad = await testPost(req(`${SETTINGS}/MOLLIE/test`, adminToken, "POST"), pp("MOLLIE"));
    const badText = await bad.text();
    expect(JSON.parse(badText).data.ok).toBe(false);
    expect(badText).not.toContain("Missing authentication");
    expect(badText).not.toContain(FAKE_TEST_KEY);
    await clearTestCooldown();
    expect((await testPost(req(`${SETTINGS}/MOLLIE/test`, writeToken, "POST"), pp("MOLLIE"))).status).toBe(403);
    await clearTestCooldown();
    expect((await testPost(req(`${SETTINGS}/UNBEKANNT/test`, adminToken, "POST"), pp("UNBEKANNT"))).status).toBe(400);
    // Ergebnis des 401 steht gespeichert; wiederherstellen.
    fake.handler = () => ({ status: 200, text: mollieFixture("methods") });
    await clearTestCooldown();
    await testPost(req(`${SETTINGS}/MOLLIE/test`, adminToken, "POST"), pp("MOLLIE"));
  });

  it("Verbindungstest ohne Schluessel -> 422 NO_KEY", async () => {
    const other = await newOrg("Ohne Schluessel GmbH");
    const token = (await createApiKey(other, { name: "x", scopes: ["admin"] })).token;
    await clearTestCooldown();
    const res = await testPost(req(`${SETTINGS}/MOLLIE/test`, token, "POST"), pp("MOLLIE"));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe("NO_KEY");
  });
});

describe("REST Bezahllink", () => {
  it("GET: read darf, liefert Adresse bei aktivem Link; fremde Org -> 404; Entwurf ohne Link", async () => {
    const res = await linkGet(req(INV(linkedId), readToken), p(linkedId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; url: string; attempts: unknown[] } };
    expect(body.data.status).toBe("ACTIVE");
    expect(body.data.url).toMatch(new RegExp(`^${BASE}/zahlen/[A-Za-z0-9_-]{43}$`));
    const none = await linkGet(req(INV(draftId), readToken), p(draftId));
    expect(((await none.json()) as { data: { status: string; url: string | null } }).data).toMatchObject({ status: "NONE", url: null });
    const f1 = await linkGet(req(INV(linkedId), foreignInvoiceToken), p(linkedId));
    const f2 = await linkGet(req(INV("gibt-es-nicht"), foreignInvoiceToken), p("gibt-es-nicht"));
    expect(f1.status).toBe(404);
    expect(await f1.text()).toBe(await f2.text());
  });

  it("POST: read -> 403; Storno-Rechnung und Gutschrift -> 422; Entwurf 422; neu 201, vorhanden 200; ohne Idempotenz-Protokoll", async () => {
    expect((await linkPost(req(INV(plainId), readToken, "POST"), p(plainId))).status).toBe(403);
    for (const id of [cancelledId, creditNoteId, draftId]) {
      const r = await linkPost(req(INV(id), writeToken, "POST"), p(id));
      expect(r.status).toBe(422);
      expect(((await r.json()) as { error: { reason: string } }).error.reason).toMatch(/INVOICE_STATE|LINK_CANCELLED/);
    }
    const headers = new Headers({ authorization: `Bearer ${writeToken}`, host: "rechnung.example.test", "idempotency-key": "pay-link-1" });
    const created = await linkPost(new Request(INV(plainId), { method: "POST", headers }), p(plainId));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { status: string; url: string } };
    expect(createdBody.data.status).toBe("ACTIVE");
    const token = createdBody.data.url.split("/zahlen/")[1]!;
    const stored = await dbInternal.apiIdempotency.findMany({ where: { orgId }, select: { key: true } });
    expect(stored.find((k) => k.key === "pay-link-1")).toBeUndefined();
    expect(JSON.stringify(await dbInternal.apiIdempotency.findMany({ where: { orgId } }))).not.toContain(token);
    const again = await linkPost(req(INV(plainId), writeToken, "POST"), p(plainId));
    expect(again.status).toBe(200);
  });

  it("disable und Reaktivierung; disable liefert nie die Adresse; fremde Org 404", async () => {
    const off = await disablePost(req(INV(plainId, "/disable"), writeToken, "POST"), p(plainId));
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { data: { status: string; url: string | null; disabledReason: string } };
    expect(offBody.data).toMatchObject({ status: "DISABLED", url: null, disabledReason: "MANUAL" });
    expect((await disablePost(req(INV(plainId, "/disable"), foreignInvoiceToken, "POST"), p(plainId))).status).toBe(404);
    expect((await disablePost(req(INV(plainId, "/disable"), readToken, "POST"), p(plainId))).status).toBe(403);
    const on = await linkPost(req(INV(plainId), writeToken, "POST"), p(plainId));
    expect(on.status).toBe(200);
    expect(((await on.json()) as { data: { status: string } }).data.status).toBe("ACTIVE");
  });

  it("refresh gleicht offene Versuche ab (Testmodus bucht nie) und enthaelt keine Adresse", async () => {
    const link = await dbInternal.invoicePayLink.findFirstOrThrow({ where: { invoiceId: linkedId }, select: { id: true } });
    await dbInternal.paymentProviderAttempt.create({
      data: { orgId, payLinkId: link.id, provider: "MOLLIE", providerObjectId: "tr_TestAbc12345", amountCents: 11900, currency: "EUR", status: "OPEN" },
    });
    let calls = 0;
    fake.handler = () => {
      calls += 1;
      return { status: 200, text: mollieFixture("payment-open") };
    };
    const res = await refreshPost(req(INV(linkedId, "/refresh"), writeToken, "POST"), p(linkedId));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { data: { checked: number; errors: number; payLink: { url: string | null; attempts: Array<{ status: string }> } } };
    expect(calls).toBe(1);
    expect(body.data).toMatchObject({ checked: 1, errors: 0 });
    expect(body.data.payLink.url).toBeNull();
    expect(text).not.toContain("checkout");
    expect((await refreshPost(req(INV(linkedId, "/refresh"), readToken, "POST"), p(linkedId))).status).toBe(403);
    expect((await refreshPost(req(INV(linkedId, "/refresh"), foreignInvoiceToken, "POST"), p(linkedId))).status).toBe(404);
  });
});

describe("Contact und Zahlungsart: Vorgabe", () => {
  it("PATCH onlinePaymentProvider: NONE/MOLLIE/null gespeichert, ungueltig -> 400", async () => {
    const url = `${BASE}/api/v1/Contact/${customerId}`;
    for (const v of ["NONE", "MOLLIE", null]) {
      const r = await contactPatch(req(url, writeToken, "PATCH", { onlinePaymentProvider: v }), p(customerId));
      expect(r.status).toBe(200);
      expect(((await r.json()) as { data: { onlinePaymentProvider: string | null } }).data.onlinePaymentProvider).toBe(v);
    }
    expect((await contactPatch(req(url, writeToken, "PATCH", { onlinePaymentProvider: "PAYPAL" }), p(customerId))).status).toBe(400);
  });
});

describe("MCP", () => {
  it("alle sieben Werkzeuge sind registriert", () => {
    for (const n of [
      "get_online_payment_settings",
      "update_online_payment_settings",
      "test_online_payment_connection",
      "get_invoice_pay_link",
      "create_invoice_pay_link",
      "disable_invoice_pay_link",
      "refresh_invoice_pay_link",
    ]) {
      expect(tools()[n], n).toBeDefined();
    }
  });

  it("Einstellungen lesen/setzen ohne Schluessel; Schluessel/Einschalter abgelehnt", async () => {
    const get = await callTool("get_online_payment_settings");
    expect(get.isError).toBeUndefined();
    expect(get.content[0]!.text).not.toContain(FAKE_TEST_KEY);
    expect(get.content[0]!.text).toContain("hasApiKey");
    const upd = await callTool("update_online_payment_settings", { showOnPdf: false });
    expect(upd.isError).toBeUndefined();
    expect(JSON.parse(upd.content[0]!.text)).toMatchObject({ showOnPdf: false });
    await callTool("update_online_payment_settings", { showOnPdf: true });
    const bad = await callTool("update_online_payment_settings", { apiKey: "test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).not.toContain("test_xxxx");
    expect((await callTool("update_online_payment_settings", {})).isError).toBe(true);
    const enabled = await callTool("update_online_payment_settings", { enabled: false });
    expect(enabled.isError).toBe(true);
    // Erlaubtes Feld zusammen mit verbotenem: abgelehnt, nichts gespeichert.
    const mixed = await callTool("update_online_payment_settings", { showOnPdf: false, apiKey: "test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(mixed.isError).toBe(true);
    expect(mixed.content[0]!.text).not.toContain("test_xxxx");
    const after = await callTool("get_online_payment_settings");
    expect(JSON.parse(after.content[0]!.text)).toMatchObject({ showOnPdf: true });
    const mixed2 = await callTool("update_online_payment_settings", { showInMail: false, enabled: true });
    expect(mixed2.isError).toBe(true);
  });

  it("Verbindungstest", async () => {
    fake.handler = () => ({ status: 200, text: mollieFixture("methods") });
    await clearTestCooldown();
    const ok = await callTool("test_online_payment_connection", { provider: "MOLLIE" });
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({ ok: true });
    fake.handler = () => ({ status: 401, text: mollieFixture("error-401") });
    await clearTestCooldown();
    const bad = await callTool("test_online_payment_connection", { provider: "MOLLIE" });
    expect(JSON.parse(bad.content[0]!.text)).toMatchObject({ ok: false });
    expect(bad.content[0]!.text).not.toContain(FAKE_TEST_KEY);
    fake.handler = () => ({ status: 200, text: mollieFixture("methods") });
    await clearTestCooldown();
    await callTool("test_online_payment_connection", { provider: "MOLLIE" });
  });

  it("Verbindungstest: Mindestabstand je Organisation (REST 429, MCP Fehler)", async () => {
    fake.handler = () => ({ status: 200, text: mollieFixture("methods") });
    await clearTestCooldown();
    expect((await testPost(req(`${SETTINGS}/MOLLIE/test`, adminToken, "POST"), pp("MOLLIE"))).status).toBe(200);
    const again = await testPost(req(`${SETTINGS}/MOLLIE/test`, adminToken, "POST"), pp("MOLLIE"));
    expect(again.status).toBe(429);
    expect(JSON.stringify(await again.json())).toContain("Verbindungstest zu schnell hintereinander");
    const mcp = await callTool("test_online_payment_connection", { provider: "MOLLIE" });
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]!.text).toContain("zu schnell");
  });

  it("Bezahllink: lesen (Adresse), Fehler wie REST, deaktivieren (ohne Adresse), anlegen, abgleichen", async () => {
    const got = await callTool("get_invoice_pay_link", { invoice: linkedNumber });
    expect(JSON.parse(got.content[0]!.text)).toMatchObject({ status: "ACTIVE" });
    expect(got.content[0]!.text).toContain("/zahlen/");
    const storno = await callTool("create_invoice_pay_link", { invoice: cancelledId });
    expect(storno.isError).toBe(true);
    expect(storno.content[0]!.text).toMatch(/INVOICE_STATE|LINK_CANCELLED/);
    expect((await callTool("create_invoice_pay_link", { invoice: creditNoteId })).isError).toBe(true);
    expect((await callTool("get_invoice_pay_link", { invoice: "gibt-es-nicht" })).isError).toBe(true);
    const off = await callTool("disable_invoice_pay_link", { invoice: plainId });
    expect(JSON.parse(off.content[0]!.text)).toMatchObject({ status: "DISABLED", url: null });
    expect(off.content[0]!.text).not.toContain("/zahlen/");
    const on = await callTool("create_invoice_pay_link", { invoice: plainId });
    expect(JSON.parse(on.content[0]!.text)).toMatchObject({ status: "ACTIVE" });
    expect(on.content[0]!.text).toContain("/zahlen/");
    fake.handler = () => ({ status: 200, text: mollieFixture("payment-open") });
    const refreshed = await callTool("refresh_invoice_pay_link", { invoice: linkedId });
    expect(refreshed.isError).toBeUndefined();
    expect(refreshed.content[0]!.text).not.toContain("/zahlen/");
    const rows = await dbInternal.activityLog.findMany({ where: { orgId, entityId: plainId, type: { in: ["PAY_LINK_DISABLED", "PAY_LINK_REACTIVATED"] } }, select: { actor: true } });
    expect(rows.some((r) => r.actor === "mcp")).toBe(true);
  });
});

describe("Stripe: REST und MCP", () => {
  const stripeAccount = (text: string) =>
    (JSON.parse(text) as { data: { accounts: Array<{ provider: string; hasApiKey: boolean; hasWebhookSecret: boolean; requiresWebhookSecret: boolean }> } }).data.accounts.find((a) => a.provider === "STRIPE");

  beforeAll(async () => {
    await dbInternal.paymentProviderAccount.create({
      data: {
        orgId,
        provider: "STRIPE",
        enabled: false,
        mode: "LIVE",
        apiKeyEnc: encryptSecret(FAKE_STRIPE_LIVE_KEY, PAYMENT_PROVIDER_KEY_PURPOSE),
        webhookPathId: `wh-stripe-${orgId}`,
      },
    });
  });

  it("GET zeigt beide Konten; hasWebhookSecret false, danach true; nie Schluessel, Signaturschluessel oder Pfadkennung", async () => {
    const first = await (await settingsGet(req(SETTINGS, adminToken))).text();
    expect(JSON.parse(first).data.accounts.map((a: { provider: string }) => a.provider)).toEqual(["MOLLIE", "STRIPE"]);
    expect(stripeAccount(first)).toMatchObject({ hasApiKey: true, hasWebhookSecret: false, requiresWebhookSecret: true });
    await dbInternal.paymentProviderAccount.update({
      where: { orgId_provider: { orgId, provider: "STRIPE" } },
      data: { webhookSecretEnc: encryptSecret(FAKE_STRIPE_SIGNING_SECRET, PAYMENT_WEBHOOK_SECRET_PURPOSE) },
    });
    const second = await (await settingsGet(req(SETTINGS, adminToken))).text();
    expect(stripeAccount(second)).toMatchObject({ hasWebhookSecret: true });
    const mcp = (await callTool("get_online_payment_settings")).content[0]!.text;
    expect(stripeAccount(JSON.stringify({ data: JSON.parse(mcp) }))).toMatchObject({ hasWebhookSecret: true });
    for (const t of [first, second, mcp]) {
      expect(t).not.toContain(FAKE_STRIPE_LIVE_KEY);
      expect(t).not.toContain(FAKE_STRIPE_SIGNING_SECRET);
      expect(t).not.toContain("whsec_");
      expect(t).not.toContain("webhookPathId");
      expect(t).not.toContain(`wh-stripe-${orgId}`);
    }
  });

  it("PUT: defaultProvider STRIPE ok; webhookSecret/apiKey -> 400 ohne Echo; Scope write 403", async () => {
    const ok = await settingsPut(req(SETTINGS, adminToken, "PUT", { defaultProvider: "STRIPE" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { defaultProvider: string } }).data.defaultProvider).toBe("STRIPE");
    for (const bad of [{ webhookSecret: FAKE_STRIPE_SIGNING_SECRET }, { apiKey: FAKE_STRIPE_LIVE_KEY }]) {
      const res = await settingsPut(req(SETTINGS, adminToken, "PUT", bad));
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(FAKE_STRIPE_SIGNING_SECRET);
      expect(text).not.toContain(FAKE_STRIPE_LIVE_KEY);
    }
    expect((await settingsPut(req(SETTINGS, writeToken, "PUT", { defaultProvider: "MOLLIE" }))).status).toBe(403);
    await settingsPut(req(SETTINGS, adminToken, "PUT", { defaultProvider: "MOLLIE" }));
  });

  it("Verbindungstest STRIPE: ok, 401, Scope write 403", async () => {
    fake.handler = () => ({ status: 200, text: JSON.stringify({ object: "list", data: [], has_more: false }) });
    await clearTestCooldown();
    const res = await testPost(req(`${SETTINGS}/STRIPE/test`, adminToken, "POST"), pp("STRIPE"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
    fake.handler = () => ({ status: 401, text: JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid API Key provided" } }) });
    await clearTestCooldown();
    const bad = await (await testPost(req(`${SETTINGS}/STRIPE/test`, adminToken, "POST"), pp("STRIPE"))).text();
    expect(JSON.parse(bad).data.ok).toBe(false);
    expect(bad).not.toContain("Invalid API Key");
    expect(bad).not.toContain(FAKE_STRIPE_LIVE_KEY);
    await clearTestCooldown();
    expect((await testPost(req(`${SETTINGS}/STRIPE/test`, writeToken, "POST"), pp("STRIPE"))).status).toBe(403);
  });

  it("Contact: onlinePaymentProvider STRIPE ok, PAYPAL 400", async () => {
    const url = `${BASE}/api/v1/Contact/${customerId}`;
    const r = await contactPatch(req(url, writeToken, "PATCH", { onlinePaymentProvider: "STRIPE" }), p(customerId));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: { onlinePaymentProvider: string | null } }).data.onlinePaymentProvider).toBe("STRIPE");
    expect((await contactPatch(req(url, writeToken, "PATCH", { onlinePaymentProvider: "PAYPAL" }), p(customerId))).status).toBe(400);
    await contactPatch(req(url, writeToken, "PATCH", { onlinePaymentProvider: null }), p(customerId));
  });

  it("MCP: webhookSecret abgelehnt ohne Echo, defaultProvider STRIPE ok, Verbindungstest STRIPE", async () => {
    const bad = await callTool("update_online_payment_settings", { webhookSecret: FAKE_STRIPE_SIGNING_SECRET });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).not.toContain(FAKE_STRIPE_SIGNING_SECRET);
    const mixed = await callTool("update_online_payment_settings", { defaultProvider: "STRIPE", webhookSecret: FAKE_STRIPE_SIGNING_SECRET });
    expect(mixed.isError).toBe(true);
    const ok = await callTool("update_online_payment_settings", { defaultProvider: "STRIPE" });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({ defaultProvider: "STRIPE" });
    await callTool("update_online_payment_settings", { defaultProvider: "MOLLIE" });
    fake.handler = () => ({ status: 200, text: JSON.stringify({ object: "list", data: [], has_more: false }) });
    await clearTestCooldown();
    const t = await callTool("test_online_payment_connection", { provider: "STRIPE" });
    expect(t.isError).toBeUndefined();
    expect(JSON.parse(t.content[0]!.text)).toMatchObject({ ok: true });
  });
});
