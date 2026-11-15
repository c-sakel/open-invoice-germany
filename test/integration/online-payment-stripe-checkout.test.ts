/** Bezahlseite und Checkout mit Stripe (nur Fake-Transport, nie Netz). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbInternal } from "@/lib/db";
import { encryptSecret, PAYMENT_PROVIDER_KEY_PURPOSE, PAYMENT_WEBHOOK_SECRET_PURPOSE } from "@/lib/crypto/secrets";
import { ensureOrgMasterdata } from "@/domain/masterdata/ensure";
import { saveDocumentSettings } from "@/domain/document/settings";
import { createDraftInvoice } from "@/domain/invoice/create";
import { finalizeInvoice } from "@/domain/invoice/finalize";
import { cancelInvoice } from "@/domain/invoice/cancel";
import { recordPayment } from "@/domain/invoice/payment";
import { revealPayLinkUrl } from "@/domain/online-payment/pay-link";
import { loadPayPage, startCheckout } from "@/domain/online-payment/checkout";
import { onlinePaymentCancelIdle, setOnlinePaymentTransportOverride } from "@/domain/online-payment/cancel-open";
import { createInvoiceSchema } from "@/schemas";
import { FAKE_STRIPE_LIVE_KEY, FAKE_STRIPE_SIGNING_SECRET, FAKE_STRIPE_TEST_KEY, createStripeFake, stripeFixture } from "../helpers/stripe-fake";

const NOW = new Date("2221-03-10T10:00:00.000Z");
const BASE = "https://rechnung.example.org";
const prevSecret = process.env.AUTH_SECRET;
const prevBase = process.env.APP_BASE_URL;

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

async function setup(name: string, opts: { accountEnabled?: boolean; mode?: "TEST" | "LIVE" } = {}) {
  const org = await dbInternal.organization.create({
    data: { legalName: name, addressLine1: "Teststr. 1", postalCode: "10115", city: "Berlin", vatId: "DE777888999", taxNumber: "44/444/44444" },
  });
  const orgId = org.id;
  await ensureOrgMasterdata(dbInternal, orgId);
  await saveDocumentSettings(orgId, { viesCheckEnabled: false });
  const prefix = `OS21-${orgId.slice(-6)}-`;
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "INVOICE", year: 2221 } },
    create: { orgId, docType: "INVOICE", year: 2221, currentValue: 0, prefix, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "INVOICE", year: { not: 2221 } }, data: { isActive: false } });
  await dbInternal.numberRange.upsert({
    where: { orgId_docType_year: { orgId, docType: "CREDIT_NOTE", year: 2221 } },
    create: { orgId, docType: "CREDIT_NOTE", year: 2221, currentValue: 0, prefix: `OG21-${orgId.slice(-6)}-`, pattern: "{PREFIX}{YYYY}-{SEQ}", seqPadding: 4, isActive: true },
    update: { currentValue: 0, prefix: `OG21-${orgId.slice(-6)}-`, isActive: true },
  });
  await dbInternal.numberRange.updateMany({ where: { orgId, docType: "CREDIT_NOTE", year: { not: 2221 } }, data: { isActive: false } });
  await dbInternal.paymentProviderSettings.create({ data: { orgId, defaultProvider: "STRIPE" } });
  await dbInternal.paymentProviderAccount.create({
    data: {
      orgId,
      provider: "STRIPE",
      enabled: true,
      mode: opts.mode ?? "LIVE",
      apiKeyEnc: encryptSecret((opts.mode ?? "LIVE") === "LIVE" ? FAKE_STRIPE_LIVE_KEY : FAKE_STRIPE_TEST_KEY, PAYMENT_PROVIDER_KEY_PURPOSE),
      webhookSecretEnc: encryptSecret(FAKE_STRIPE_SIGNING_SECRET, PAYMENT_WEBHOOK_SECRET_PURPOSE),
      webhookPathId: `wh-${orgId}`,
      lastTestOk: true,
    },
  });
  const customer = await dbInternal.customer.create({
    data: { orgId, name: "Geheimkunde AG", addressLine1: "Marktplatz 2", postalCode: "20095", city: "Hamburg", type: "BUSINESS" },
  });
  const d = await createDraftInvoice(
    orgId,
    createInvoiceSchema.parse({
      customerId: customer.id,
      issueDate: NOW,
      deliveryDate: new Date("2221-03-05"),
      notes: "GEHEIME-NOTIZ",
      internalReference: "GEHEIME-NOTIZ",
      lines: [{ description: "Beratung", quantityMilli: 1000, unit: "HUR", unitNetPriceCents: 10000, taxRate: 19, taxCategory: "S" }],
    }),
    { now: NOW },
  );
  const inv = await finalizeInvoice(d.id, { now: NOW });
  const url = await revealPayLinkUrl(orgId, inv.id, BASE);
  if (!url) throw new Error("Link fehlt");
  // Konto erst nach dem Festschreiben ausschalten (sonst entsteht kein Link).
  if (opts.accountEnabled === false) await dbInternal.paymentProviderAccount.updateMany({ where: { orgId }, data: { enabled: false } });
  return { orgId, invoiceId: inv.id, number: inv.number ?? "", token: url.split("/zahlen/")[1]! };
}


let counter = 0;
/** Fake, das Betrag/Kennung der Anfrage spiegelt; Modus je Schluessel. */
function fakeStripe(opts: { livemode?: boolean; host?: string; fail?: number } = {}) {
  const livemode = opts.livemode ?? true;
  const fake = createStripeFake({
    "POST /checkout/sessions": (req) => {
      if (opts.fail) return { status: opts.fail, text: stripeFixture("error-401") };
      const form = new URLSearchParams(req.body ?? "");
      counter += 1;
      const id = `cs_${livemode ? "live" : "test"}_FAKE${String(counter).padStart(6, "0")}`;
      return {
        status: 200,
        text: JSON.stringify({
          id,
          object: "checkout.session",
          status: "open",
          payment_status: "unpaid",
          amount_total: Number(form.get("line_items[0][price_data][unit_amount]")),
          currency: form.get("line_items[0][price_data][currency]"),
          livemode,
          client_reference_id: form.get("client_reference_id"),
          expires_at: Number(form.get("expires_at")),
          payment_intent: null,
          url: `https://${opts.host ?? "checkout.stripe.com"}/c/pay/${id}`,
        }),
      };
    },
  });
  return fake;
}

const attemptsOf = (orgId: string) =>
  dbInternal.paymentProviderAttempt.findMany({
    where: { orgId },
    select: { id: true, status: true, amountCents: true, providerObjectId: true, checkoutUrl: true, error: true, expiresAt: true },
    orderBy: { createdAt: "asc" },
  });

describe("Stripe: Bezahlseite und Checkout", () => {
  it("erster Klick: genau ein POST, Betrag = Rest, Ablauf now+3600, Idempotency-Key = Attempt-Id, Attempt OPEN; zweiter Klick ohne Netz", async () => {
    const s = await setup("Stripe Klick GmbH");
    await recordPayment(s.invoiceId, { amountCents: 4000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: NOW });
    expect(await loadPayPage(s.token)).toMatchObject({ kind: "PAYABLE", provider: "STRIPE", openCents: 7900, testMode: false });
    const fake = fakeStripe();
    const r1 = await startCheckout(s.token, { transport: fake.transport, now: NOW });
    expect(r1).toMatchObject({ kind: "REDIRECT" });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.method).toBe("POST");
    expect(new URL(call.url).pathname).toBe("/v1/checkout/sessions");
    const form = new URLSearchParams(call.body ?? "");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("7900");
    expect(form.get("expires_at")).toBe(String(Math.floor(NOW.getTime() / 1000) + 3600));
    expect(form.get("success_url")).toBe(`${BASE}/zahlen/${s.token}?zurueck=1`);
    const [a] = await attemptsOf(s.orgId);
    expect(a).toMatchObject({ status: "OPEN", amountCents: 7900 });
    expect(a!.providerObjectId).toMatch(/^cs_live_/);
    expect(call.headers["Idempotency-Key"]).toBe(a!.id);
    expect(r1).toEqual({ kind: "REDIRECT", url: a!.checkoutUrl });
    const r2 = await startCheckout(s.token, { transport: fake.transport, now: NOW });
    expect(r2).toEqual(r1);
    expect(fake.calls).toHaveLength(1);
    expect(await attemptsOf(s.orgId)).toHaveLength(1);
  });

  it("geaenderter Rest: neue Sitzung und expire fuer die alte, alter Vorgang CANCELED", async () => {
    const s = await setup("Stripe Rest GmbH");
    const fake = fakeStripe();
    await startCheckout(s.token, { transport: fake.transport, now: NOW });
    const [first] = await attemptsOf(s.orgId);
    fake.routes[`POST /checkout/sessions/${first!.providerObjectId}/expire`] = { status: 200, text: "{}" };
    await recordPayment(s.invoiceId, { amountCents: 1000, method: "TRANSFER", isSkonto: false, applySkonto: false }, { orgId: s.orgId, now: NOW });
    await startCheckout(s.token, { transport: fake.transport, now: NOW });
    const rows = await attemptsOf(s.orgId);
    expect(rows.map((x) => x.status)).toEqual(["CANCELED", "OPEN"]);
    expect(rows[1]!.amountCents).toBe(10900);
    expect(fake.calls.filter((c) => c.url.endsWith("/expire"))).toHaveLength(1);
    expect(fake.calls.filter((c) => c.url.endsWith("/checkout/sessions") && c.method === "POST")).toHaveLength(2);
  });

  it("Antwort mit fremdem Host: Attempt FAILED, UNAVAILABLE", async () => {
    const s = await setup("Stripe Host GmbH");
    expect(await startCheckout(s.token, { transport: fakeStripe({ host: "evil.example.org" }).transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    const rows = await attemptsOf(s.orgId);
    expect(rows.map((x) => x.status)).toEqual(["FAILED"]);
    expect(rows[0]!.error).toBe("Anlage beim Zahlungsanbieter fehlgeschlagen.");
  });

  it("Anbieterfehler: FAILED mit festem Text, kein Anbietertext", async () => {
    const s = await setup("Stripe Fehler GmbH");
    const r = await startCheckout(s.token, { transport: fakeStripe({ fail: 401 }).transport, now: NOW });
    expect(r).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    const rows = await attemptsOf(s.orgId);
    expect(rows[0]).toMatchObject({ status: "FAILED", error: "Anlage beim Zahlungsanbieter fehlgeschlagen." });
    expect(JSON.stringify(rows)).not.toContain("Invalid API Key");
  });

  it("Konto TEST und live ausgegebener Link (liveIssued): UNAVAILABLE ohne Netz", async () => {
    const s = await setup("Stripe Testlive GmbH", { mode: "TEST" });
    await dbInternal.invoicePayLink.updateMany({ where: { invoiceId: s.invoiceId }, data: { liveIssued: true } });
    const fake = fakeStripe({ livemode: false });
    expect(await loadPayPage(s.token)).toMatchObject({ kind: "UNAVAILABLE" });
    expect(await startCheckout(s.token, { transport: fake.transport, now: NOW })).toMatchObject({ kind: "PAGE", state: { kind: "UNAVAILABLE" } });
    expect(fake.calls).toHaveLength(0);
    // Nicht live ausgegebener Link auf dem Testkonto bleibt nutzbar (Testmodus).
    await dbInternal.invoicePayLink.updateMany({ where: { invoiceId: s.invoiceId }, data: { liveIssued: false } });
    expect(await loadPayPage(s.token)).toMatchObject({ kind: "PAYABLE", testMode: true });
  });

  it("Storno mit offener Sitzung: expire aufgerufen, Link DISABLED", async () => {
    const s = await setup("Stripe Storno GmbH");
    const fake = fakeStripe();
    await startCheckout(s.token, { transport: fake.transport, now: NOW });
    const [open] = await attemptsOf(s.orgId);
    const sessionId = open!.providerObjectId!;
    fake.routes[`POST /checkout/sessions/${sessionId}/expire`] = { status: 200, text: "{}" };
    fake.routes[`GET /checkout/sessions/${sessionId}`] = { status: 200, text: JSON.stringify({ ...(JSON.parse(stripeFixture("session-expired")) as object), id: sessionId, client_reference_id: open!.id }) };
    setOnlinePaymentTransportOverride(fake.transport);
    await cancelInvoice(s.invoiceId, { orgId: s.orgId, now: NOW });
    await onlinePaymentCancelIdle();
    expect(fake.calls.filter((c) => c.url.endsWith(`/${sessionId}/expire`))).toHaveLength(1);
    const link = await dbInternal.invoicePayLink.findUniqueOrThrow({ where: { invoiceId: s.invoiceId }, select: { status: true } });
    expect(link.status).toBe("DISABLED");
    expect(await loadPayPage(s.token)).toMatchObject({ kind: "CANCELLED" });
    setOnlinePaymentTransportOverride(null);
  });
});
