import { describe, expect, it } from "vitest";
import { mollieAdapter } from "@/lib/payment/mollie";
import { adapterFor } from "@/lib/payment/registry";
import { PaymentNetworkForbiddenError, assertAllowedPaymentUrl, defaultPaymentTransport } from "@/lib/payment/transport";
import { PaymentProviderError, type CheckoutRequest } from "@/lib/payment/types";
import { FAKE_LIVE_KEY, FAKE_TEST_KEY, createMollieFake, mollieFixture } from "../helpers/mollie-fake";

const req: CheckoutRequest = {
  attemptId: "att_test_0001",
  amountCents: 11900,
  currency: "EUR",
  description: "Rechnung RE-1",
  redirectUrl: "https://rechnung.example.org/pay/x/return",
  cancelUrl: "https://rechnung.example.org/pay/x",
  webhookUrl: "https://rechnung.example.org/api/payment/webhook/MOLLIE",
  locale: "de",
  methods: null,
};

describe("Mollie-Adapter", () => {
  it("legt eine Zahlung mit exaktem Body und Headern an", async () => {
    const fake = createMollieFake({ "POST /payments": { status: 201, text: mollieFixture("payment-open") } });
    const out = await mollieAdapter.createCheckout(FAKE_TEST_KEY, req, fake.transport);
    expect(out.checkoutUrl).toBe("https://www.mollie.com/checkout/select-method/TestAbc12345");
    expect(out.objectId).toBe("tr_TestAbc12345");
    const c = fake.calls[0]!;
    expect(c.url).toBe("https://api.mollie.com/v2/payments");
    expect(c.headers.Authorization).toBe(`Bearer ${FAKE_TEST_KEY}`);
    expect(c.headers["Idempotency-Key"]).toBe("att_test_0001");
    expect(JSON.parse(c.body ?? "")).toEqual({
      amount: { currency: "EUR", value: "119.00" },
      description: "Rechnung RE-1",
      redirectUrl: req.redirectUrl,
      cancelUrl: req.cancelUrl,
      webhookUrl: req.webhookUrl,
      locale: "de_DE",
      metadata: { attemptId: "att_test_0001" },
    });
  });
  it("sendet method nur mit Auswahl und en_US", async () => {
    const fake = createMollieFake({ "POST /payments": { status: 201, text: mollieFixture("payment-open") } });
    await mollieAdapter.createCheckout(FAKE_TEST_KEY, { ...req, locale: "en", methods: ["ideal"] }, fake.transport);
    const b = JSON.parse(fake.calls[0]!.body ?? "") as Record<string, unknown>;
    expect(b.method).toEqual(["ideal"]);
    expect(b.locale).toBe("en_US");
  });
  it("kuerzt die Beschreibung auf 255 Zeichen", async () => {
    const fake = createMollieFake({ "POST /payments": { status: 201, text: mollieFixture("payment-open") } });
    await mollieAdapter.createCheckout(FAKE_TEST_KEY, { ...req, description: "x".repeat(400) }, fake.transport);
    expect((JSON.parse(fake.calls[0]!.body ?? "") as { description: string }).description).toHaveLength(255);
  });
  it("lehnt Antwort ohne checkout-Link oder ohne 201 ab", async () => {
    const noLink = JSON.stringify({ ...JSON.parse(mollieFixture("payment-open")), _links: {} });
    const f1 = createMollieFake({ "POST /payments": { status: 201, text: noLink } });
    await expect(mollieAdapter.createCheckout(FAKE_TEST_KEY, req, f1.transport)).rejects.toMatchObject({ kind: "invalid" });
    const f2 = createMollieFake({ "POST /payments": { status: 200, text: mollieFixture("payment-open") } });
    await expect(mollieAdapter.createCheckout(FAKE_TEST_KEY, req, f2.transport)).rejects.toBeInstanceOf(PaymentProviderError);
  });
  it("lehnt eine http-Bezahladresse ab", async () => {
    const bad = JSON.stringify({ ...JSON.parse(mollieFixture("payment-open")), _links: { checkout: { href: "http://x.example.org/" } } });
    const f = createMollieFake({ "POST /payments": { status: 201, text: bad } });
    await expect(mollieAdapter.createCheckout(FAKE_TEST_KEY, req, f.transport)).rejects.toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["payment-open", "OPEN", 0, 0],
    ["payment-paid", "PAID", 0, 0],
    ["payment-paid-refunded-partial", "PAID", 1950, 0],
    ["payment-paid-chargeback", "PAID", 0, 11900],
    ["payment-expired", "EXPIRED", 0, 0],
    ["payment-canceled", "CANCELED", 0, 0],
  ])("Fixture %s -> %s", async (name, status, refunded, charged) => {
    const fake = createMollieFake({ "GET /payments/tr_TestAbc12345": { status: 200, text: mollieFixture(name) } });
    const s = await mollieAdapter.fetchPayment(FAKE_TEST_KEY, "tr_TestAbc12345", fake.transport);
    expect(s).toMatchObject({ status, refundedCents: refunded, chargedBackCents: charged, amountCents: 11900, currency: "EUR", testMode: true, attemptId: "att_test_0001" });
  });
  it("liest paidAt und Modus", async () => {
    const live = JSON.stringify({ ...JSON.parse(mollieFixture("payment-paid")), mode: "live" });
    const fake = createMollieFake({ "GET /payments/tr_TestAbc12345": { status: 200, text: live } });
    const s = await mollieAdapter.fetchPayment(FAKE_LIVE_KEY, "tr_TestAbc12345", fake.transport);
    expect(s?.testMode).toBe(false);
    expect(s?.paidAt?.toISOString()).toBe("2026-11-20T09:30:00.000Z");
  });
  it("404 -> null, ungueltige Id ohne Aufruf", async () => {
    const fake = createMollieFake();
    expect(await mollieAdapter.fetchPayment(FAKE_TEST_KEY, "tr_Unbekannt1", fake.transport)).toBeNull();
    await expect(mollieAdapter.fetchPayment(FAKE_TEST_KEY, "../x", fake.transport)).rejects.toBeInstanceOf(PaymentProviderError);
    expect(fake.calls).toHaveLength(1);
  });
  it("401 -> auth ohne Schluessel in der Meldung, 500 -> transient", async () => {
    const f1 = createMollieFake({ "GET /methods": { status: 401, text: mollieFixture("error-401") } });
    const e1 = await mollieAdapter.testConnection(FAKE_LIVE_KEY, f1.transport).catch((e: unknown) => e);
    expect(e1).toMatchObject({ kind: "auth", status: 401 });
    expect((e1 as Error).message).not.toContain(FAKE_LIVE_KEY);
    expect((e1 as Error).message).not.toContain("Missing authentication");
    const f2 = createMollieFake({ "GET /methods": { status: 500, text: "boom" } });
    await expect(mollieAdapter.testConnection(FAKE_LIVE_KEY, f2.transport)).rejects.toMatchObject({ kind: "transient" });
    const f3 = createMollieFake({ "POST /payments": { status: 422, text: mollieFixture("error-422") } });
    await expect(mollieAdapter.createCheckout(FAKE_LIVE_KEY, req, f3.transport)).rejects.toMatchObject({ kind: "invalid" });
  });
  it("Transportfehler -> transient ohne Originaltext", async () => {
    const err = await mollieAdapter
      .testConnection(FAKE_LIVE_KEY, async () => {
        throw new Error(`Bearer ${FAKE_LIVE_KEY}`);
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "transient" });
    expect((err as Error).message).not.toContain(FAKE_LIVE_KEY);
  });
  it("testConnection liefert Methoden", async () => {
    const fake = createMollieFake({ "GET /methods": { status: 200, text: mollieFixture("methods") } });
    expect(await mollieAdapter.testConnection(FAKE_TEST_KEY, fake.transport)).toEqual({ methods: ["ideal", "creditcard"] });
  });
  it("cancelCheckout: 200 true, 422 false", async () => {
    const ok = createMollieFake({ "DELETE /payments/tr_TestAbc12345": { status: 200, text: "{}" } });
    expect(await mollieAdapter.cancelCheckout(FAKE_TEST_KEY, "tr_TestAbc12345", ok.transport)).toBe(true);
    const no = createMollieFake({ "DELETE /payments/tr_TestAbc12345": { status: 422, text: mollieFixture("error-422") } });
    expect(await mollieAdapter.cancelCheckout(FAKE_TEST_KEY, "tr_TestAbc12345", no.transport)).toBe(false);
  });

  it("parseWebhook akzeptiert nur das Feld id", () => {
    const h = new Headers();
    expect(mollieAdapter.parseWebhook("id=tr_TestAbc12345", h)).toEqual({ objectId: "tr_TestAbc12345" });
    expect(mollieAdapter.parseWebhook('{"id":"tr_TestAbc12345"}', h)).toBeNull();
    expect(mollieAdapter.parseWebhook("id=tr_TestAbc12345&x=1", h)).toBeNull();
    expect(mollieAdapter.parseWebhook("id=tr_TestAbc12345&id=tr_Zweite12345", h)).toBeNull();
    expect(mollieAdapter.parseWebhook("id=../etc", h)).toBeNull();
    expect(mollieAdapter.parseWebhook("", h)).toBeNull();
  });
  it("modeFromKey, Waehrungen, Auszahlungsmuster", () => {
    expect(mollieAdapter.modeFromKey(FAKE_TEST_KEY)).toBe("TEST");
    expect(mollieAdapter.modeFromKey(FAKE_LIVE_KEY)).toBe("LIVE");
    expect(mollieAdapter.modeFromKey("access_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(mollieAdapter.modeFromKey("test_kurz")).toBeNull();
    expect(mollieAdapter.supportsCurrency("EUR")).toBe(true);
    expect(mollieAdapter.supportsCurrency("JPY")).toBe(false);
    expect(mollieAdapter.payoutPattern.test("MOLLIE Payments B.V.")).toBe(true);
    expect(adapterFor("MOLLIE")).toBe(mollieAdapter);
  });
  it("Standard-Transport ist unter Vitest gesperrt", async () => {
    await expect(defaultPaymentTransport()({ method: "GET", url: "https://api.mollie.com/v2/methods", headers: {} })).rejects.toBeInstanceOf(PaymentNetworkForbiddenError);
  });

  it("Transport erlaubt nur api.mollie.com ueber https", () => {
    expect(() => assertAllowedPaymentUrl("https://api.mollie.com/v2/payments")).not.toThrow();
    for (const bad of [
      "https://evil.example.org/v2/payments",
      "https://api.mollie.com.evil.example.org/v2",
      "https://sub.api.mollie.com/v2",
      "http://api.mollie.com/v2",
      "https://user:pw@api.mollie.com/v2",
      "https://api.mollie.com:8443/v2",
      "kein-url",
    ]) {
      expect(() => assertAllowedPaymentUrl(bad), bad).toThrow(PaymentProviderError);
    }
  });
  it("externalRequest ohne injizierten fetch ist unter Vitest gesperrt", async () => {
    const { externalRequest, ExternalHttpError } = await import("@/lib/http/external");
    await expect(externalRequest("https://api.mollie.com/v2/methods", { method: "GET" })).rejects.toBeInstanceOf(ExternalHttpError);
  });
  it("createCheckout lehnt Betrag <= 0 und nicht unterstuetzte Waehrung vor dem Aufruf ab", async () => {
    const fake = createMollieFake({ "POST /payments": { status: 201, text: mollieFixture("payment-open") } });
    for (const bad of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 1.5 }, { currency: "JPY" }, { methods: ["ide al"] }]) {
      await expect(mollieAdapter.createCheckout(FAKE_TEST_KEY, { ...req, ...bad }, fake.transport)).rejects.toMatchObject({ kind: "invalid" });
    }
    expect(fake.calls).toHaveLength(0);
  });
  it("createCheckout gleicht Betrag, Waehrung und Modus der Antwort ab", async () => {
    const base = JSON.parse(mollieFixture("payment-open")) as Record<string, unknown>;
    const variants = [
      { ...base, amount: { currency: "EUR", value: "1.00" } },
      { ...base, amount: { currency: "USD", value: "119.00" } },
      { ...base, mode: "live" },
    ];
    for (const v of variants) {
      const f = createMollieFake({ "POST /payments": { status: 201, text: JSON.stringify(v) } });
      await expect(mollieAdapter.createCheckout(FAKE_TEST_KEY, req, f.transport)).rejects.toMatchObject({ kind: "invalid" });
    }
  });
  it("fetchPayment lehnt abweichenden Modus ab", async () => {
    const fake = createMollieFake({ "GET /payments/tr_TestAbc12345": { status: 200, text: mollieFixture("payment-paid") } });
    await expect(mollieAdapter.fetchPayment(FAKE_LIVE_KEY, "tr_TestAbc12345", fake.transport)).rejects.toMatchObject({ kind: "invalid" });
  });
  it("unbekannter Anbieter-Status -> UNKNOWN statt Parsefehler", async () => {
    const odd = JSON.stringify({ ...JSON.parse(mollieFixture("payment-open")), status: "neuer_status" });
    const fake = createMollieFake({ "GET /payments/tr_TestAbc12345": { status: 200, text: odd } });
    expect((await mollieAdapter.fetchPayment(FAKE_TEST_KEY, "tr_TestAbc12345", fake.transport))?.status).toBe("UNKNOWN");
  });
  it("cancelCheckout: 404 -> false; Beschreibung trennt keine Surrogatpaare", async () => {
    const nf = createMollieFake();
    expect(await mollieAdapter.cancelCheckout(FAKE_TEST_KEY, "tr_TestAbc12345", nf.transport)).toBe(false);
    const fake = createMollieFake({ "POST /payments": { status: 201, text: mollieFixture("payment-open") } });
    await mollieAdapter.createCheckout(FAKE_TEST_KEY, { ...req, description: "\u{1F600}".repeat(300) }, fake.transport);
    const d = (JSON.parse(fake.calls[0]!.body ?? "") as { description: string }).description;
    expect([...d]).toHaveLength(255);
    expect(d).not.toContain("\uFFFD");
  });
});
