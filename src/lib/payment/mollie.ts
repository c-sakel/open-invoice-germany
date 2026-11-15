import { z } from "zod";
import { TWO_DECIMAL_CURRENCIES, centsToDecimal, decimalToCents } from "./amount";
import {
  PaymentProviderError,
  type CheckoutRequest,
  type PaymentProviderAdapter,
  type PaymentTransport,
  type ProviderPaymentState,
} from "./types";

const BASE = "https://api.mollie.com/v2";
const OBJECT_ID = /^tr_[A-Za-z0-9]{4,64}$/;

const amountSchema = z.object({ currency: z.string().min(3).max(3), value: z.string() });

export const mollieErrorSchema = z.object({
  status: z.number().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
});

export const molliePaymentSchema = z.object({
  id: z.string().regex(OBJECT_ID),
  mode: z.enum(["test", "live"]),
  status: z.enum(["open", "pending", "authorized", "paid", "expired", "canceled", "failed"]),
  amount: amountSchema,
  amountRefunded: amountSchema.optional(),
  amountChargedBack: amountSchema.optional(),
  paidAt: z.string().nullish(),
  expiresAt: z.string().nullish(),
  metadata: z.unknown().optional(),
  _links: z.object({ checkout: z.object({ href: z.string() }).optional() }).optional(),
});

export const mollieMethodsSchema = z.object({
  _embedded: z.object({ methods: z.array(z.object({ id: z.string() })) }),
});

function fail(status: number): never {
  if (status === 401 || status === 403) throw new PaymentProviderError("auth", `Zahlungsanbieter lehnt den Zugang ab (HTTP ${status}).`, status);
  if (status === 404) throw new PaymentProviderError("not_found", "Zahlungsanbieter: Objekt nicht gefunden (HTTP 404).", 404);
  if (status >= 400 && status < 500) throw new PaymentProviderError("invalid", `Zahlungsanbieter lehnt die Anfrage ab (HTTP ${status}).`, status);
  throw new PaymentProviderError("transient", `Zahlungsanbieter nicht erreichbar oder gestoert (HTTP ${status}).`, status);
}

async function call(
  t: PaymentTransport,
  key: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  extra?: { body?: string; idempotencyKey?: string },
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
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

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function cents(a: { value: string } | undefined): number {
  if (!a) return 0;
  try {
    return decimalToCents(a.value);
  } catch {
    throw new PaymentProviderError("invalid", "Unerwarteter Betrag vom Zahlungsanbieter.");
  }
}

function toState(p: z.infer<typeof molliePaymentSchema>): ProviderPaymentState {
  const status: ProviderPaymentState["status"] =
    p.status === "paid" ? "PAID" : p.status === "expired" ? "EXPIRED" : p.status === "canceled" ? "CANCELED" : p.status === "failed" ? "FAILED" : "OPEN";
  const md = p.metadata;
  const attemptId =
    md && typeof md === "object" && "attemptId" in md && typeof (md as { attemptId: unknown }).attemptId === "string"
      ? (md as { attemptId: string }).attemptId
      : null;
  return {
    objectId: p.id,
    testMode: p.mode === "test",
    status,
    amountCents: cents(p.amount),
    currency: p.amount.currency,
    refundedCents: cents(p.amountRefunded),
    chargedBackCents: cents(p.amountChargedBack),
    paidAt: parseDate(p.paidAt),
    expiresAt: parseDate(p.expiresAt),
    attemptId,
  };
}

export const mollieAdapter: PaymentProviderAdapter = {
  provider: "MOLLIE",
  payoutPattern: /\bmollie\b/i,

  modeFromKey(key) {
    const m = /^(test|live)_[A-Za-z0-9]{26,}$/.exec(key);
    return m ? (m[1] === "test" ? "TEST" : "LIVE") : null;
  },

  supportsCurrency(currency) {
    return (TWO_DECIMAL_CURRENCIES as readonly string[]).includes(currency);
  },

  async createCheckout(key, req: CheckoutRequest, t) {
    const body: Record<string, unknown> = {
      amount: { currency: req.currency, value: centsToDecimal(req.amountCents) },
      description: req.description.slice(0, 255),
      redirectUrl: req.redirectUrl,
      cancelUrl: req.cancelUrl,
      webhookUrl: req.webhookUrl,
      locale: req.locale === "de" ? "de_DE" : "en_US",
      metadata: { attemptId: req.attemptId },
    };
    if (req.methods && req.methods.length > 0) body.method = req.methods;
    const res = await call(t, key, "POST", "/payments", { body: JSON.stringify(body), idempotencyKey: req.attemptId });
    if (res.status !== 201) fail(res.status);
    const p = parseJson(molliePaymentSchema, res.text);
    const href = p._links?.checkout?.href;
    if (!href) throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters ohne Bezahladresse.");
    let ok = false;
    try {
      ok = new URL(href).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) throw new PaymentProviderError("invalid", "Antwort des Zahlungsanbieters mit ungueltiger Bezahladresse.");
    return { objectId: p.id, checkoutUrl: href, expiresAt: parseDate(p.expiresAt) };
  },

  async fetchPayment(key, objectId, t) {
    if (!OBJECT_ID.test(objectId)) throw new PaymentProviderError("invalid", "Ungueltige Objekt-Id.");
    const res = await call(t, key, "GET", `/payments/${objectId}`);
    if (res.status === 404) return null;
    if (res.status !== 200) fail(res.status);
    return toState(parseJson(molliePaymentSchema, res.text));
  },

  async cancelCheckout(key, objectId, t) {
    if (!OBJECT_ID.test(objectId)) throw new PaymentProviderError("invalid", "Ungueltige Objekt-Id.");
    const res = await call(t, key, "DELETE", `/payments/${objectId}`);
    if (res.status === 200) return true;
    if (res.status === 422) return false;
    return fail(res.status);
  },

  async testConnection(key, t) {
    const res = await call(t, key, "GET", "/methods");
    if (res.status !== 200) fail(res.status);
    const m = parseJson(mollieMethodsSchema, res.text);
    return { methods: m._embedded.methods.map((x) => x.id) };
  },

  parseWebhook(rawBody) {
    const params = new URLSearchParams(rawBody);
    const keys = [...params.keys()];
    if (keys.length !== 1 || keys[0] !== "id" || params.getAll("id").length !== 1) return null;
    const id = params.get("id") ?? "";
    return OBJECT_ID.test(id) ? { objectId: id } : null;
  },
};
