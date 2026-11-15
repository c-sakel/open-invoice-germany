import { describe, expect, it } from "vitest";
import { adapterFor, allowedPaymentHosts, isTrustedPaymentCheckoutUrl } from "@/lib/payment/registry";
import { STRIPE_API_VERSION, stripeAdapter } from "@/lib/payment/stripe";
import { assertAllowedPaymentUrl } from "@/lib/payment/transport";
import { PaymentProviderError, type CheckoutRequest } from "@/lib/payment/types";
import {
  FAKE_STRIPE_LIVE_KEY as LIVE,
  FAKE_STRIPE_PUBLISHABLE_KEY,
  FAKE_STRIPE_RESTRICTED_LIVE_KEY,
  FAKE_STRIPE_SIGNING_SECRET as SECRET,
  FAKE_STRIPE_TEST_KEY as TEST,
  createStripeFake,
  signStripeEvent,
  stripeFixture,
  stripeFixtureWith,
} from "../helpers/stripe-fake";

const NOW = new Date("2026-11-15T10:00:00Z");
const req: CheckoutRequest = {
  attemptId: "att_test_0001",
  amountCents: 11900,
  currency: "EUR",
  description: "Rechnung RE-1",
  redirectUrl: "https://rechnung.example.org/zahlen/x?zurueck=1",
  cancelUrl: "https://rechnung.example.org/zahlen/x",
  webhookUrl: "https://rechnung.example.org/api/public/payments/stripe/x",
  locale: "de",
  methods: null,
  now: NOW,
};
const SID = "cs_live_FAKEsession0001";
const getRoutes = (fixture: string, extra: Record<string, { status: number; text: string }> = {}) => ({
  [`GET /checkout/sessions/${SID}`]: { status: 200, text: stripeFixture(fixture) },
  ...extra,
});

describe("Stripe-Adapter", () => {
  it("legt eine Sitzung mit exaktem Formular-Body und Headern an", async () => {
    const fake = createStripeFake({ "POST /checkout/sessions": { status: 200, text: stripeFixture("session-open") } });
    const out = await stripeAdapter.createCheckout(TEST, req, fake.transport);
    expect(out).toEqual({
      objectId: "cs_test_FAKEsession0001",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_FAKEsession0001",
      expiresAt: new Date(1794000000 * 1000),
    });
    const c = fake.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(c.headers).toEqual({
      Authorization: `Bearer ${TEST}`,
      "Stripe-Version": STRIPE_API_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": "att_test_0001",
    });
    const form = new URLSearchParams(c.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "eur",
      "line_items[0][price_data][unit_amount]": "11900",
      "line_items[0][price_data][product_data][name]": "Rechnung RE-1",
      success_url: req.redirectUrl,
      cancel_url: req.cancelUrl,
      client_reference_id: "att_test_0001",
      "metadata[attemptId]": "att_test_0001",
      "payment_intent_data[metadata][attemptId]": "att_test_0001",
      "payment_intent_data[description]": "Rechnung RE-1",
      expires_at: String(Math.floor(NOW.getTime() / 1000) + 3600),
      locale: "de",
      "adaptive_pricing[enabled]": "false",
    });
    expect(c.body).not.toContain("customer_email");
    expect(c.body).not.toContain("webhook");
    expect(c.body).not.toContain("allowed_payment_method_types");
  });
  it("sendet Methoden nur mit Auswahl und lehnt unbekannte ab", async () => {
    const fake = createStripeFake({ "POST /checkout/sessions": { status: 200, text: stripeFixture("session-open") } });
    await stripeAdapter.createCheckout(TEST, { ...req, methods: ["card", "sepa_debit"], locale: "en" }, fake.transport);
    const form = new URLSearchParams(fake.calls[0]!.body ?? "");
    expect(form.get("allowed_payment_method_types[0]")).toBe("card");
    expect(form.get("allowed_payment_method_types[1]")).toBe("sepa_debit");
    expect(form.get("locale")).toBe("en");
    await expect(stripeAdapter.createCheckout(TEST, { ...req, methods: ["karte"] }, fake.transport)).rejects.toMatchObject({ kind: "invalid" });
    expect(fake.calls).toHaveLength(1);
  });
  it("lehnt Betrag <= 0, Waehrung und Fremdschluessel vor dem Aufruf ab", async () => {
    const fake = createStripeFake({ "POST /checkout/sessions": { status: 200, text: stripeFixture("session-open") } });
    for (const bad of [{ amountCents: 0 }, { amountCents: -5 }, { amountCents: 1.5 }, { currency: "JPY" }]) {
      await expect(stripeAdapter.createCheckout(TEST, { ...req, ...bad }, fake.transport)).rejects.toMatchObject({ kind: "invalid" });
    }
    await expect(stripeAdapter.createCheckout(FAKE_STRIPE_PUBLISHABLE_KEY, req, fake.transport)).rejects.toMatchObject({ kind: "invalid" });
    expect(fake.calls).toHaveLength(0);
  });
  it("Waehrung wird kleingeschrieben gesendet und gross verglichen", async () => {
    const fake = createStripeFake({ "POST /checkout/sessions": { status: 200, text: stripeFixtureWith("session-open", { currency: "usd" }) } });
    await expect(stripeAdapter.createCheckout(TEST, { ...req, currency: "USD" }, fake.transport)).resolves.toBeTruthy();
    expect(new URLSearchParams(fake.calls[0]!.body ?? "").get("line_items[0][price_data][currency]")).toBe("usd");
    await expect(stripeAdapter.createCheckout(TEST, req, fake.transport)).rejects.toMatchObject({ kind: "invalid" });
  });
  it("Beschreibung wird auf 250 Zeichen gekuerzt, ohne Surrogatpaare zu trennen", async () => {
    const fake = createStripeFake({ "POST /checkout/sessions": { status: 200, text: stripeFixture("session-open") } });
    await stripeAdapter.createCheckout(TEST, { ...req, description: "\u{1F600}".repeat(300) }, fake.transport);
    const name = new URLSearchParams(fake.calls[0]!.body ?? "").get("line_items[0][price_data][product_data][name]") ?? "";
    expect([...name]).toHaveLength(250);
    expect(name).not.toContain("�");
  });
  it("createCheckout gleicht Antwort mit der Anfrage ab", async () => {
    const variants = [
      stripeFixtureWith("session-open", { amount_total: 100 }),
      stripeFixtureWith("session-open", { livemode: true }),
      stripeFixtureWith("session-open", { status: "complete" }),
      stripeFixtureWith("session-open", { url: "https://evil.example/c/pay/x" }),
      stripeFixtureWith("session-open", { url: "https://checkout.stripe.com.evil.example/x" }),
      stripeFixtureWith("session-open", { url: null }),
      stripeFixtureWith("session-open", { id: "cs_test_kurz" }),
    ];
    for (const v of variants) {
      const f = createStripeFake({ "POST /checkout/sessions": { status: 200, text: v } });
      await expect(stripeAdapter.createCheckout(TEST, req, f.transport), v).rejects.toMatchObject({ kind: "invalid" });
    }
    const f = createStripeFake({ "POST /checkout/sessions": { status: 201, text: stripeFixture("session-open") } });
    await expect(stripeAdapter.createCheckout(TEST, req, f.transport)).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it("fetchPayment bildet jede Fixture auf einen Zustand ab", async () => {
    const paid = createStripeFake(getRoutes("session-paid"));
    expect(await stripeAdapter.fetchPayment(LIVE, SID, paid.transport)).toEqual({
      objectId: SID,
      testMode: false,
      status: "PAID",
      amountCents: 11900,
      currency: "EUR",
      refundedCents: 0,
      chargedBackCents: 0,
      paidAt: null,
      expiresAt: new Date(1794000000 * 1000),
      attemptId: "att_test_0001",
      paymentRef: "pi_FAKEaaaa0001",
    });
    expect(paid.calls[0]!.url).toBe(`https://api.stripe.com/v1/checkout/sessions/${SID}?expand%5B%5D=payment_intent.latest_charge`);
    expect(paid.calls).toHaveLength(1);

    const cases: [string, Partial<{ status: string; refundedCents: number; paymentRef: string | null }>][] = [
      ["session-paid-refunded-partial", { status: "PAID", refundedCents: 5000 }],
      ["session-async-processing", { status: "OPEN", paymentRef: "pi_FAKEaaaa0001" }],
      ["session-async-failed", { status: "FAILED" }],
      ["session-expired", { status: "EXPIRED", paymentRef: null }],
    ];
    for (const [name, want] of cases) {
      const f = createStripeFake(getRoutes(name));
      expect(await stripeAdapter.fetchPayment(LIVE, SID, f.transport), name).toMatchObject(want);
    }
    const open = createStripeFake({ [`GET /checkout/sessions/cs_test_FAKEsession0001`]: { status: 200, text: stripeFixture("session-open") } });
    expect(await stripeAdapter.fetchPayment(TEST, "cs_test_FAKEsession0001", open.transport)).toMatchObject({ status: "OPEN", testMode: true });
  });
  it("nicht expandierte Charge fuehrt zu Fehler statt Erstattung 0", async () => {
    const body = JSON.parse(stripeFixture("session-paid")) as { payment_intent: Record<string, unknown> };
    body.payment_intent.latest_charge = "ch_FAKEaaaa0001";
    const f = createStripeFake({ [`GET /checkout/sessions/${SID}`]: { status: 200, text: JSON.stringify(body) } });
    await expect(stripeAdapter.fetchPayment(LIVE, SID, f.transport)).rejects.toMatchObject({ kind: "invalid" });
  });
  it("createCheckout: abweichende client_reference_id wird abgelehnt", async () => {
    const fake = createStripeFake({ "POST /checkout/sessions": { status: 200, text: stripeFixtureWith("session-open", { client_reference_id: "att_other" }) } });
    await expect(stripeAdapter.createCheckout(TEST, req, fake.transport)).rejects.toMatchObject({ kind: "invalid" });
  });
  it("createCheckout: lose Surrogate in der Beschreibung -> PaymentProviderError", async () => {
    const fake = createStripeFake({ "POST /checkout/sessions": { status: 200, text: stripeFixture("session-open") } });
    await expect(stripeAdapter.createCheckout(TEST, { ...req, description: "Rechnung \uD800" }, fake.transport)).rejects.toBeInstanceOf(PaymentProviderError);
    expect(fake.calls).toHaveLength(0);
  });
  it("Streitfaelle: abgezogen zaehlt, zurueckgebucht und Warnung nicht", async () => {
    const disputes = (name: string) => createStripeFake(getRoutes("session-paid-disputed", { "GET /disputes": { status: 200, text: stripeFixture(name) } }));
    const w = disputes("disputes-withdrawn");
    expect((await stripeAdapter.fetchPayment(LIVE, SID, w.transport))?.chargedBackCents).toBe(11900);
    expect(w.calls[1]!.url).toBe("https://api.stripe.com/v1/disputes?payment_intent=pi_FAKEaaaa0001&limit=10");
    expect((await stripeAdapter.fetchPayment(LIVE, SID, disputes("disputes-reinstated").transport))?.chargedBackCents).toBe(0);
    expect((await stripeAdapter.fetchPayment(LIVE, SID, disputes("disputes-warning").transport))?.chargedBackCents).toBe(0);
    const failing = createStripeFake(getRoutes("session-paid-disputed", { "GET /disputes": { status: 500, text: "boom" } }));
    await expect(stripeAdapter.fetchPayment(LIVE, SID, failing.transport)).rejects.toMatchObject({ kind: "transient" });
  });
  it("fetchPayment: 404 -> null, Modus/Id/Zahlungs-Id werden geprueft", async () => {
    expect(await stripeAdapter.fetchPayment(LIVE, SID, createStripeFake().transport)).toBeNull();
    // Testsitzung mit Live-Schluessel.
    const wrongMode = createStripeFake({ [`GET /checkout/sessions/${SID}`]: { status: 200, text: stripeFixture("session-test-mode") } });
    await expect(stripeAdapter.fetchPayment(LIVE, SID, wrongMode.transport)).rejects.toMatchObject({ kind: "invalid" });
    const otherId = createStripeFake({ [`GET /checkout/sessions/${SID}`]: { status: 200, text: stripeFixtureWith("session-paid", { id: "cs_live_FAKEandere0002" }) } });
    await expect(stripeAdapter.fetchPayment(LIVE, SID, otherId.transport)).rejects.toMatchObject({ kind: "invalid" });
    const noPi = createStripeFake({ [`GET /checkout/sessions/${SID}`]: { status: 200, text: stripeFixtureWith("session-paid", { payment_intent: null }) } });
    await expect(stripeAdapter.fetchPayment(LIVE, SID, noPi.transport)).rejects.toMatchObject({ kind: "invalid" });
    await expect(stripeAdapter.fetchPayment(LIVE, "../etc", createStripeFake().transport)).rejects.toMatchObject({ kind: "invalid" });
  });
  it("unbekannter Status -> UNKNOWN statt Parsefehler", async () => {
    const f = createStripeFake({ [`GET /checkout/sessions/${SID}`]: { status: 200, text: stripeFixtureWith("session-paid", { status: "neuer_status" }) } });
    expect((await stripeAdapter.fetchPayment(LIVE, SID, f.transport))?.status).toBe("UNKNOWN");
  });

  it("401 -> auth ohne Schluessel in der Meldung, 500 -> transient, Transportfehler ohne Originaltext", async () => {
    const f1 = createStripeFake({ "GET /checkout/sessions": { status: 401, text: stripeFixture("error-401") } });
    const e1 = await stripeAdapter.testConnection(LIVE, f1.transport).catch((e: unknown) => e);
    expect(e1).toMatchObject({ kind: "auth", status: 401 });
    expect((e1 as Error).message).not.toContain(LIVE);
    expect((e1 as Error).message).not.toContain("Invalid API Key");
    const statuses: [number, string][] = [[403, "auth"], [400, "invalid"], [402, "invalid"], [404, "not_found"], [409, "transient"], [429, "transient"], [500, "transient"]];
    for (const [st, kind] of statuses) {
      const f = createStripeFake({ "GET /checkout/sessions": { status: st, text: "{}" } });
      await expect(stripeAdapter.testConnection(LIVE, f.transport), String(st)).rejects.toMatchObject({ kind });
    }
    const err = await stripeAdapter
      .testConnection(LIVE, async () => {
        throw new Error(`Bearer ${LIVE}`);
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "transient" });
    expect((err as Error).message).not.toContain(LIVE);
  });
  it("testConnection prueft das Leserecht", async () => {
    const f = createStripeFake({ "GET /checkout/sessions": { status: 200, text: '{"object":"list","data":[]}' } });
    expect(await stripeAdapter.testConnection(LIVE, f.transport)).toEqual({ methods: [] });
    expect(f.calls[0]!.url).toBe("https://api.stripe.com/v1/checkout/sessions?limit=1");
  });
  it("cancelCheckout: 200 true, 400/404 false, 500 transient", async () => {
    const ok = createStripeFake({ [`POST /checkout/sessions/${SID}/expire`]: { status: 200, text: "{}" } });
    expect(await stripeAdapter.cancelCheckout(LIVE, SID, ok.transport)).toBe(true);
    expect(ok.calls[0]!.headers["Idempotency-Key"]).toBeUndefined();
    expect(await stripeAdapter.cancelCheckout(LIVE, SID, createStripeFake({ [`POST /checkout/sessions/${SID}/expire`]: { status: 400, text: "{}" } }).transport)).toBe(false);
    expect(await stripeAdapter.cancelCheckout(LIVE, SID, createStripeFake().transport)).toBe(false);
    await expect(stripeAdapter.cancelCheckout(LIVE, SID, createStripeFake({ [`POST /checkout/sessions/${SID}/expire`]: { status: 500, text: "" } }).transport)).rejects.toMatchObject({ kind: "transient" });
  });

  it("modeFromKey, Waehrungen, Auszahlungsmuster, Registry", () => {
    expect(stripeAdapter.modeFromKey(TEST)).toBe("TEST");
    expect(stripeAdapter.modeFromKey(LIVE)).toBe("LIVE");
    expect(stripeAdapter.modeFromKey(FAKE_STRIPE_RESTRICTED_LIVE_KEY)).toBe("LIVE");
    expect(stripeAdapter.modeFromKey(FAKE_STRIPE_PUBLISHABLE_KEY)).toBeNull();
    expect(stripeAdapter.modeFromKey("sk_test_kurz")).toBeNull();
    expect(stripeAdapter.supportsCurrency("EUR")).toBe(true);
    expect(stripeAdapter.supportsCurrency("JPY")).toBe(false);
    expect(stripeAdapter.payoutPattern.test("STRIPE PAYMENTS EUROPE")).toBe(true);
    expect(stripeAdapter.webhookAuth).toBe("signature");
    expect(stripeAdapter.webhookBodyMax).toBe(131_072);
    expect(stripeAdapter.knownMethods).toContain("card");
    expect(adapterFor("STRIPE")).toBe(stripeAdapter);
  });
  it("Transport und Bezahladresse kennen Stripe-Hosts, sonst nichts dazu", () => {
    expect(allowedPaymentHosts().has("api.stripe.com")).toBe(true);
    expect(() => assertAllowedPaymentUrl("https://api.stripe.com/v1/checkout/sessions")).not.toThrow();
    for (const bad of ["https://checkout.stripe.com/x", "https://api.stripe.com.evil.example/v1", "http://api.stripe.com/v1", "https://api.stripe.com:444/v1"]) {
      expect(() => assertAllowedPaymentUrl(bad), bad).toThrow(PaymentProviderError);
    }
    expect(isTrustedPaymentCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_x")).toBe(true);
    expect(isTrustedPaymentCheckoutUrl("https://api.stripe.com/c/pay/x")).toBe(false);
    expect(isTrustedPaymentCheckoutUrl("https://pay.stripe.com.evil.example/x")).toBe(false);
  });
});

describe("Stripe-Ereignisse", () => {
  const T = Math.floor(NOW.getTime() / 1000);
  const parse = (body: string, secret: string | null = SECRET, header?: string | null) => {
    const h = new Headers();
    const sig = header === undefined ? signStripeEvent(body, SECRET, T) : header;
    if (sig !== null) h.set("stripe-signature", sig);
    return stripeAdapter.parseWebhook(Buffer.from(body, "utf8"), h, { signingSecret: secret, now: NOW });
  };
  it("Sitzungsereignisse liefern die Sitzungs-Id", () => {
    for (const t of ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"]) {
      const body = stripeFixtureWith("event-checkout-completed", { type: t });
      expect(parse(body), t).toEqual({ kind: "REF", ref: { objectId: SID }, livemode: true });
    }
  });
  it("Charge- und Dispute-Ereignisse liefern die PaymentIntent-Id", () => {
    expect(parse(stripeFixture("event-charge-refunded"))).toEqual({ kind: "REF", ref: { paymentRef: "pi_FAKEaaaa0001" }, livemode: true });
    expect(parse(stripeFixture("event-dispute-funds-withdrawn"))).toEqual({ kind: "REF", ref: { paymentRef: "pi_FAKEaaaa0001" }, livemode: true });
    for (const t of ["charge.refund.updated", "charge.dispute.created", "charge.dispute.funds_reinstated", "charge.dispute.closed"]) {
      expect(parse(stripeFixtureWith("event-charge-refunded", { type: t })), t).toMatchObject({ kind: "REF", ref: { paymentRef: "pi_FAKEaaaa0001" } });
    }
  });
  it("fehlender PaymentIntent und fremde Typen -> IRRELEVANT, kaputte Ids -> FORMAT", () => {
    const noPi = JSON.stringify({ ...JSON.parse(stripeFixture("event-charge-refunded")), data: { object: { id: "ch_x", payment_intent: null } } });
    expect(parse(noPi)).toEqual({ kind: "IRRELEVANT" });
    expect(parse(stripeFixtureWith("event-charge-refunded", { type: "customer.created" }))).toEqual({ kind: "IRRELEVANT" });
    const badPi = JSON.stringify({ ...JSON.parse(stripeFixture("event-charge-refunded")), data: { object: { payment_intent: "../x" } } });
    expect(parse(badPi)).toEqual({ kind: "REJECT", reason: "FORMAT" });
    const badSession = JSON.stringify({ ...JSON.parse(stripeFixture("event-checkout-completed")), data: { object: { id: "x" } } });
    expect(parse(badSession)).toEqual({ kind: "REJECT", reason: "FORMAT" });
  });
  it("Thin-Ereignisse, fehlendes Secret, schlechte Signatur, kaputtes JSON", () => {
    expect(parse(stripeFixture("event-thin"))).toEqual({ kind: "REJECT", reason: "UNSUPPORTED_FORMAT" });
    expect(parse(stripeFixture("event-charge-refunded"), null)).toEqual({ kind: "REJECT", reason: "NO_SECRET" });
    expect(parse(stripeFixture("event-charge-refunded"), SECRET, null)).toEqual({ kind: "REJECT", reason: "FORMAT" });
    expect(parse(stripeFixture("event-charge-refunded"), SECRET, `t=${T},v1=${"0".repeat(64)}`)).toEqual({ kind: "REJECT", reason: "SIGNATURE" });
    expect(parse(stripeFixture("event-charge-refunded"), SECRET, signStripeEvent(stripeFixture("event-charge-refunded"), SECRET, T - 400))).toEqual({ kind: "REJECT", reason: "STALE" });
    expect(parse("kein json")).toEqual({ kind: "REJECT", reason: "FORMAT" });
    expect(parse('{"object":"event"}')).toEqual({ kind: "REJECT", reason: "FORMAT" });
  });
  it("Signatur wird vor dem JSON-Parse geprueft (kaputtes JSON mit falscher Signatur -> SIGNATURE)", () => {
    expect(parse("kein json", SECRET, `t=${T},v1=${"0".repeat(64)}`)).toEqual({ kind: "REJECT", reason: "SIGNATURE" });
  });
});
