/**
 * Rate-Limits der oeffentlichen Bezahlseite. Je Client-IP; ohne ermittelbare IP gilt ein gemeinsamer
 * Notschluessel mit hoeherem Limit (kein fail-open). Zusaetzlich je Token-Hash. Wirft `RateLimitError`.
 */
import { rateLimit } from "@/lib/rate-limit";
import { hashToken } from "@/domain/quote-share/token";
import { payLinkTokenSchema } from "@/schemas/online-payment";

const IP_LIMIT = 60;
const UNKNOWN_IP_LIMIT = 300;
const IP_WINDOW_MS = 60_000;
const PAGE_TOKEN_LIMIT = 30;
const PAGE_TOKEN_WINDOW_MS = 60_000;
const CHECKOUT_TOKEN_LIMIT = 5;
const CHECKOUT_TOKEN_WINDOW_MS = 10 * 60_000;

export function enforcePayRateLimit(opts: { ip: string | null; token: string; scope: "page" | "checkout" }): void {
  if (opts.ip) rateLimit(`public:ip:${opts.ip}`, { limit: IP_LIMIT, windowMs: IP_WINDOW_MS });
  else rateLimit("public:ip:unknown", { limit: UNKNOWN_IP_LIMIT, windowMs: IP_WINDOW_MS });
  if (!payLinkTokenSchema.safeParse(opts.token).success) return;
  const hash = hashToken(opts.token);
  if (opts.scope === "page") rateLimit(`pay-page:${hash}`, { limit: PAGE_TOKEN_LIMIT, windowMs: PAGE_TOKEN_WINDOW_MS });
  else rateLimit(`pay-checkout:${hash}`, { limit: CHECKOUT_TOKEN_LIMIT, windowMs: CHECKOUT_TOKEN_WINDOW_MS });
}
