export const ONLINE_PROVIDERS = ["MOLLIE", "STRIPE"] as const;
export type OnlineProvider = (typeof ONLINE_PROVIDERS)[number];

export type PaymentTransportRequest = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
};
export type PaymentTransport = (req: PaymentTransportRequest) => Promise<{ status: number; text: string }>;

export interface CheckoutRequest {
  attemptId: string;
  amountCents: number;
  currency: string;
  description: string;
  redirectUrl: string;
  cancelUrl: string;
  webhookUrl: string;
  locale: "de" | "en";
  methods: string[] | null;
  /** Bezugszeitpunkt (z. B. Ablauf der Sitzung beim Anbieter). */
  now: Date;
}

export interface ProviderPaymentState {
  objectId: string;
  testMode: boolean;
  /** UNKNOWN: vom Anbieter gemeldeter, uns unbekannter Status -> keine Buchung, nur Protokoll. */
  status: "OPEN" | "PAID" | "EXPIRED" | "CANCELED" | "FAILED" | "UNKNOWN";
  amountCents: number;
  currency: string;
  refundedCents: number;
  chargedBackCents: number;
  paidAt: Date | null;
  expiresAt: Date | null;
  attemptId: string | null;
  /** Zahlungs-Id beim Anbieter (Mollie = objectId, Stripe = PaymentIntent); null solange nicht bekannt. */
  paymentRef: string | null;
}

export type WebhookRef = { objectId: string } | { paymentRef: string };

export type WebhookParse =
  | { kind: "REF"; ref: WebhookRef; livemode: boolean | null }
  /** Gueltig, aber ohne Bedeutung fuer uns -> 200 ohne Netz. */
  | { kind: "IRRELEVANT" }
  | { kind: "REJECT"; reason: "FORMAT" | "SIGNATURE" | "STALE" | "UNSUPPORTED_FORMAT" | "NO_SECRET" };

export interface PaymentProviderAdapter {
  provider: OnlineProvider;
  payoutPattern: RegExp;
  /** fetch-only: Benachrichtigung unsigniert, nur Verweis; signature: Signatur ueber den Rohbody vor jeder Auswertung. */
  webhookAuth: "fetch-only" | "signature";
  webhookBodyMax: number;
  /** Bekannte Zahlungsmethoden-Kennungen; null = nicht eingeschraenkt. */
  knownMethods: readonly string[] | null;
  /** Hosts, die der Transport fuer diesen Anbieter erreichen darf (exakter Hostname, nur https). */
  allowedHosts: readonly string[];
  /** Hosts, auf die der Zahler zur Bezahlung weitergeleitet werden darf (exakter Hostname, nur https). */
  checkoutHosts: readonly string[];
  modeFromKey(key: string): "TEST" | "LIVE" | null;
  supportsCurrency(currency: string): boolean;
  createCheckout(
    key: string,
    req: CheckoutRequest,
    t: PaymentTransport,
  ): Promise<{ objectId: string; checkoutUrl: string; expiresAt: Date | null }>;
  /** 404 -> null; Modus der Antwort muss zum Schluessel passen (sonst invalid) */
  fetchPayment(key: string, objectId: string, t: PaymentTransport): Promise<ProviderPaymentState | null>;
  cancelCheckout(key: string, objectId: string, t: PaymentTransport): Promise<boolean>;
  testConnection(key: string, t: PaymentTransport): Promise<{ methods: string[] }>;
  parseWebhook(raw: Buffer, headers: Headers, ctx: { signingSecret: string | null; now: Date }): WebhookParse;
}

export type PaymentProviderErrorKind = "auth" | "invalid" | "not_found" | "transient";

export class PaymentProviderError extends Error {
  constructor(
    readonly kind: PaymentProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
