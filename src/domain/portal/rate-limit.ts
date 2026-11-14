/**
 * Rate-Limits der oeffentlichen Portalpfade. Je Client-IP; ohne ermittelbare IP gilt ein gemeinsamer
 * Notschluessel mit hoeherem Limit (kein fail-open). Zusaetzlich je Token-Hash, damit ein einzelner Link
 * nicht beliebig oft abgerufen werden kann. Wirft `RateLimitError`.
 */
import { rateLimit } from "@/lib/rate-limit";
import { hashToken, isWellFormedPortalToken } from "@/domain/portal/token";

const WINDOW_MS = 60_000;
const IP_LIMIT = 60;
/** Gemeinsamer Notschluessel ohne ermittelbare IP: alle Clients teilen ihn, daher grosszuegiger. */
const UNKNOWN_IP_LIMIT = 300;

export function enforcePortalRateLimit(opts: { ip: string | null; token: string; scope: "page" | "download"; tokenLimit: number }): void {
  if (opts.ip) rateLimit(`public:ip:${opts.ip}`, { limit: IP_LIMIT, windowMs: WINDOW_MS });
  else rateLimit("public:ip:unknown", { limit: UNKNOWN_IP_LIMIT, windowMs: WINDOW_MS });
  if (isWellFormedPortalToken(opts.token)) {
    const key = opts.scope === "download" ? `portal:${hashToken(opts.token)}` : `portal-page:${hashToken(opts.token)}`;
    rateLimit(key, { limit: opts.tokenLimit, windowMs: WINDOW_MS });
  }
}
