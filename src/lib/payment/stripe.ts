import { z } from "zod";
import { isTrustedCheckoutUrl } from "./checkout-url";
import { TWO_DECIMAL_CURRENCIES } from "./amount";
import { formEncode } from "./form-encode";
import { verifyStripeSignature } from "./stripe-signature";
import {
  PaymentProviderError,
  type CheckoutRequest,
  type PaymentProviderAdapter,
  type PaymentTransport,
  type ProviderPaymentState,
  type WebhookParse,
} from "./types";

const BASE = "https://api.stripe.com/v1";
export const STRIPE_API_VERSION = "2026-10-28.endive";
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,240}$/;
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{4,200}$/;
const SESSION_TTL_S = 3600;

/**
 * Werte von `allowed_payment_method_types` (Checkout Session). Ab API-Version 2026-09-30.endive ist das der richtige
 * Parameter; `payment_method_types` wurde entfernt (docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions).
 */
export const STRIPE_KNOWN_METHODS = [
  "acss_debit", "affirm", "afterpay_clearpay", "alipay", "alma", "amazon_pay", "au_becs_debit", "bacs_debit", "bancontact",
  "billie", "bizum", "blik", "boleto", "card", "cashapp", "crypto", "customer_balance", "eps", "fpx", "giropay", "grabpay",
  "ideal", "kakao_pay", "klarna", "konbini", "kr_card", "link", "mb_way", "mobilepay", "multibanco", "naver_pay",
  "nz_bank_account", "oxxo", "p24", "pay_by_bank", "payco", "paynow", "paypal", "paypay", "payto", "pix", "promptpay",
  "revolut_pay", "samsung_pay", "satispay", "scalapay", "sepa_debit", "sequra", "sofort", "sunbit", "swish", "twint", "upi",
  "us_bank_account", "wechat_pay", "zip",
] as const;

const chargeSchema = z.object({
  id: z.string().min(1).max(255),
  amount_refunded: z.number().int().nonnegative(),
  disputed: z.boolean().optional(),
});

const paymentIntentSchema = z.object({
  id: z.string().regex(PAYMENT_INTENT_ID),
  // Bewusst z.string: neuer Anbieter-Status darf das Parsing nicht kippen.
  status: z.string().min(1).max(64),
  latest_charge: z.union([z.string(), chargeSchema, z.null()]).optional(),
});

export const stripeSessionSchema = z.object({
  id: z.string().regex(SESSION_ID),
  status: z.string().min(1).max(64),
  payment_status: z.string().min(1).max(64).optional(),
  amount_total: z.number().int().nonnegative().nullable(),
  currency: z.string().min(3).max(3).nullable(),
  livemode: z.boolean(),
  url: z.string().nullish(),
  expires_at: z.number().int().nullish(),
  client_reference_id: z.string().max(255).nullish(),
  payment_intent: z.union([z.string(), paymentIntentSchema, z.null()]).optional(),
});

export const stripeDisputeListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(255),
      amount: z.number().int().nonnegative(),
      status: z.string().min(1).max(64),
      balance_transactions: z.array(z.object({ amount: z.number().int() })).default([]),
    }),
  ),
  has_more: z.boolean().default(false),
});

const sessionListSchema = z.object({ data: z.array(z.unknown()) });

const eventSchema = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{4,200}$/),
  object: z.literal("event"),
  type: z.string().min(1).max(200),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

const SESSION_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);
const PAYMENT_REF_EVENTS = new Set([
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
]);

function fail(status: number): never {
  if (status === 401 || status === 403) throw new PaymentProviderError("auth", `Zahlungsanbieter lehnt den Zugang ab (HTTP ${status}).`, status);
  if (status === 404) throw new PaymentProviderError("not_found", "Zahlungsanbieter: Objekt nicht gefunden (HTTP 404).", 404);
  if (status === 400 || status === 402) throw new PaymentProviderError("invalid", `Zahlungsanbieter lehnt die Anfrage ab (HTTP ${status}).`, status);
  throw new PaymentProviderError("transient", `Zahlungsanbieter nicht erreichbar oder gestoert (HTTP ${status}).`, status);
}

async function call(
  t: PaymentTransport,
  key: string,
  method: "GET" | "POST",
  path: string,
  extra?: { body?: string; idempotencyKey?: string },
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_API_VERSION };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (extra?.idempotencyKey) headers["Idempotency-Key"] = extra.idempotencyKey;
  try {
    return await t({ method, url: `${BASE}${path}`, headers, ...(extra?.body !== undefined ? { body: extra.body } : {}) });
  } catch (e) {
    if (e instanceof PaymentProviderError) throw e;
    // Fehlertext des Transports bewusst verworfen (koennte Anfragedaten enthalten).
    throw new PaymentProviderError("transient", "Zahlungsanbieter nicht erreichbar.");
  }
}

function parseJson<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PaymentProviderError("invalid", "Unerwartete Antwort des Zahlungsanbieters.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new PaymentProviderError("invalid", "Unerwartete Antwort des Zahlungsanbieters.");
  return parsed.data;
}

function secondsToDate(v: number | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = new Date(v * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function modeFromKey(key: string): "TEST" | "LIVE" | null {
  const m = /^(sk|rk)_(test|live)_[A-Za-z0-9]{24,}$/.exec(key);
  return m ? (m[2] === "test" ? "TEST" : "LIVE") : null;
}

function mapStatus(s: z.infer<typeof stripeSessionSchema>): ProviderPaymentState["status"] {
  if (s.status === "open") return "OPEN";
  if (s.status === "expired") return "EXPIRED";
  if (s.status !== "complete") return "UNKNOWN";
  if (s.payment_status === "paid") return "PAID";
  if (s.payment_status !== "unpaid") return "UNKNOWN";
  const pi = typeof s.payment_intent === "object" && s.payment_intent !== null ? s.payment_intent.status : null;
  if (pi === "processing" || pi === "requires_action" || pi === "requires_capture") return "OPEN";
  if (pi === "requires_payment_method" || pi === "canceled") return "FAILED";
  return "UNKNOWN";
}

function paymentIntentOf(s: z.infer<typeof stripeSessionSchema>): { id: string | null; charge: z.infer<typeof chargeSchema> | null } {
  const pi = s.payment_intent;
  if (pi === null || pi === undefined) return { id: null, charge: null };
  if (typeof pi === "string") {
    if (!PAYMENT_INTENT_ID.test(pi)) throw new PaymentProviderError("invalid", "Unerwartete Antwort des Zahlungsanbieters.");
    return { id: pi, charge: null };
  }
  const c = pi.latest_charge;
  // Ohne expandierte Charge ist der Erstattungsstand unbekannt: nie als 0 annehmen.
  if (typeof c === "string" || (c === undefined && s.payment_status === "paid")) {
    throw new PaymentProviderError("invalid", "Unvollstaendige Antwort des Zahlungsanbieters.");
  }
  return { id: pi.id, charge: c !== null && c !== undefined && typeof c === "object" ? c : null };
}

/** Abgezogene und nicht zurueckgebuchte Streitfaelle; Warnungen ohne Saldobuchung zaehlen nicht. */
function chargedBackOf(disputes: z.infer<typeof stripeDisputeListSchema>): number {
  let sum = 0;
  for (const d of disputes.data) {
    const withdrawn = d.balance_transactions.some((b) => b.amount < 0);
    const reinstated = d.balance_transactions.some((b) => b.amount > 0);
    if (withdrawn && !reinstated) sum += d.amount;
  }
  if (!Number.isSafeInteger(sum)) throw new PaymentProviderError("invalid", "Unerwarteter Betrag vom Zahlungsanbieter.");
  return sum;
}

function toState(s: z.infer<typeof stripeSessionSchema>, chargedBackCents: number): ProviderPaymentState {
  const status = mapStatus(s);
  const { id: pi, charge } = paymentIntentOf(s);
  if (status === "PAID" && pi === null) throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters ohne Zahlungs-Id.");
  if (s.amount_total === null || s.currency === null) throw new PaymentProviderError("invalid", "Unerwarteter Betrag vom Zahlungsanbieter.");
  return {
    objectId: s.id,
    testMode: !s.livemode,
    status,
    amountCents: s.amount_total,
    currency: s.currency.toUpperCase(),
    refundedCents: charge?.amount_refunded ?? 0,
    chargedBackCents,
    // Stripe nennt keinen Zahlungszeitpunkt je Sitzung; die Buchung nutzt den Zeitpunkt der Feststellung.
    paidAt: null,
    expiresAt: secondsToDate(s.expires_at),
    attemptId: s.client_reference_id ?? null,
    paymentRef: pi,
  };
}

function assertMode(state: ProviderPaymentState, key: string): void {
  const expected = modeFromKey(key);
  if (expected === null || state.testMode !== (expected === "TEST")) {
    throw new PaymentProviderError("invalid", "Modus der Antwort passt nicht zum Schluessel.");
  }
}

function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) throw new PaymentProviderError("invalid", "Ungueltige Objekt-Id.");
}

export const stripeAdapter: PaymentProviderAdapter = {
  provider: "STRIPE",
  payoutPattern: /\bstripe\b/i,
  allowedHosts: ["api.stripe.com"],
  // Eigene Checkout-Domains des Kontos werden nicht unterstuetzt.
  checkoutHosts: ["checkout.stripe.com"],
  webhookAuth: "signature",
  webhookBodyMax: 131_072,
  knownMethods: STRIPE_KNOWN_METHODS,
  modeFromKey,

  supportsCurrency(currency) {
    return (TWO_DECIMAL_CURRENCIES as readonly string[]).includes(currency);
  },

  async createCheckout(key, req: CheckoutRequest, t) {
    if (!Number.isSafeInteger(req.amountCents) || req.amountCents <= 0) {
      throw new PaymentProviderError("invalid", "Ungueltiger Betrag fuer die Online-Zahlung.");
    }
    if (!stripeAdapter.supportsCurrency(req.currency)) {
      throw new PaymentProviderError("invalid", "Waehrung wird vom Zahlungsanbieter nicht unterstuetzt.");
    }
    if (req.methods?.some((m) => !(STRIPE_KNOWN_METHODS as readonly string[]).includes(m))) {
      throw new PaymentProviderError("invalid", "Ungueltige Zahlungsmethode.");
    }
    const expectedMode = modeFromKey(key);
    if (expectedMode === null) throw new PaymentProviderError("invalid", "Ungueltiger API-Schluessel.");
    const name = [...req.description].slice(0, 250).join("");
    const form: Record<string, unknown> = {
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: { currency: req.currency.toLowerCase(), unit_amount: req.amountCents, product_data: { name } },
        },
      ],
      success_url: req.redirectUrl,
      cancel_url: req.cancelUrl,
      client_reference_id: req.attemptId,
      metadata: { attemptId: req.attemptId },
      payment_intent_data: { metadata: { attemptId: req.attemptId }, description: name },
      expires_at: Math.floor(req.now.getTime() / 1000) + SESSION_TTL_S,
      locale: req.locale,
      adaptive_pricing: { enabled: false },
    };
    if (req.methods && req.methods.length > 0) form.allowed_payment_method_types = req.methods;
    const res = await call(t, key, "POST", "/checkout/sessions", { body: formEncode(form), idempotencyKey: req.attemptId });
    if (res.status !== 200) fail(res.status);
    const s = parseJson(stripeSessionSchema, res.text);
    if (
      s.amount_total !== req.amountCents ||
      s.currency?.toUpperCase() !== req.currency ||
      s.livemode !== (expectedMode === "LIVE") ||
      s.status !== "open"
    ) {
      throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters passt nicht zur Anfrage.");
    }
    if (s.client_reference_id !== req.attemptId) {
      throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters passt nicht zur Anfrage.");
    }
    if (!s.url) throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters ohne Bezahladresse.");
    if (!isTrustedCheckoutUrl(s.url, stripeAdapter.checkoutHosts)) {
      throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters mit ungueltiger Bezahladresse.");
    }
    return { objectId: s.id, checkoutUrl: s.url, expiresAt: secondsToDate(s.expires_at) };
  },

  async fetchPayment(key, objectId, t) {
    assertSessionId(objectId);
    const res = await call(t, key, "GET", `/checkout/sessions/${objectId}?expand%5B%5D=payment_intent.latest_charge`);
    if (res.status === 404) return null;
    if (res.status !== 200) fail(res.status);
    const s = parseJson(stripeSessionSchema, res.text);
    if (s.id !== objectId) throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters passt nicht zur Anfrage.");
    const { id: pi, charge } = paymentIntentOf(s);
    let chargedBack = 0;
    if (charge?.disputed && pi) {
      const dres = await call(t, key, "GET", `/disputes?payment_intent=${encodeURIComponent(pi)}&limit=100`);
      if (dres.status !== 200) fail(dres.status);
      const disputes = parseJson(stripeDisputeListSchema, dres.text);
      // Unvollstaendige Liste nie als vollstaendig werten: lieber unbrauchbar melden als zu wenig gegenbuchen.
      if (disputes.has_more) throw new PaymentProviderError("invalid", "Unvollstaendige Antwort des Zahlungsanbieters.");
      chargedBack = chargedBackOf(disputes);
    }
    const state = toState(s, chargedBack);
    assertMode(state, key);
    return state;
  },

  async cancelCheckout(key, objectId, t) {
    assertSessionId(objectId);
    const res = await call(t, key, "POST", `/checkout/sessions/${objectId}/expire`);
    if (res.status === 200) return true;
    if (res.status === 400 || res.status === 404) return false;
    return fail(res.status);
  },

  async testConnection(key, t) {
    const res = await call(t, key, "GET", "/checkout/sessions?limit=1");
    if (res.status !== 200) fail(res.status);
    parseJson(sessionListSchema, res.text);
    return { methods: [] };
  },

  parseWebhook(raw, headers, ctx): WebhookParse {
    if (!ctx.signingSecret) return { kind: "REJECT", reason: "NO_SECRET" };
    // Signatur zuerst, ueber die unveraenderten Rohbytes, vor jedem JSON-Parse.
    const sig = verifyStripeSignature(raw, headers.get("stripe-signature"), ctx.signingSecret, ctx.now);
    if (sig !== "OK") return { kind: "REJECT", reason: sig };
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      return { kind: "REJECT", reason: "PAYLOAD" };
    }
    if (json !== null && typeof json === "object" && (json as { object?: unknown }).object === "v2.core.event") {
      return { kind: "REJECT", reason: "UNSUPPORTED_FORMAT" };
    }
    const ev = eventSchema.safeParse(json);
    if (!ev.success) return { kind: "REJECT", reason: "PAYLOAD" };
    const { type, livemode, data } = ev.data;
    if (SESSION_EVENTS.has(type)) {
      const id = data.object.id;
      if (typeof id !== "string" || !SESSION_ID.test(id)) return { kind: "REJECT", reason: "PAYLOAD" };
      return { kind: "REF", ref: { objectId: id }, livemode };
    }
    if (PAYMENT_REF_EVENTS.has(type)) {
      const pi = data.object.payment_intent;
      if (typeof pi !== "string") return { kind: "IRRELEVANT" };
      if (!PAYMENT_INTENT_ID.test(pi)) return { kind: "REJECT", reason: "PAYLOAD" };
      return { kind: "REF", ref: { paymentRef: pi }, livemode };
    }
    return { kind: "IRRELEVANT" };
  },
};
