export const ONLINE_PROVIDERS = ["MOLLIE"] as const;
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
}

export interface PaymentProviderAdapter {
  provider: OnlineProvider;
  payoutPattern: RegExp;
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
  parseWebhook(rawBody: string, headers: Headers): { objectId: string } | null;
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
