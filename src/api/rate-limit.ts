/**
 * Rate-Limit fuer /api/v1/* (Phase 10, Task 1, task-1-facts.md): 600 Anfragen/min je
 * API-Schluessel, wiederverwendet aus src/lib/rate-limit.ts (Phase 3b). Schluessel
 * `apikey:<id>` — getrennt vom Namensraum der oeffentlichen Routen (`public:*`,
 * `decide:*`, `pdf:*`), damit sich Kontingente nicht ueberschneiden.
 */
import { NextResponse } from "next/server";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";

export const API_RATE_LIMIT = 600;
export const API_RATE_WINDOW_MS = 60_000;

/** Verbraucht ein Kontingent fuer den API-Schluessel; wirft RateLimitError bei Ueberschreitung. */
export function checkApiRateLimit(apiKeyId: string): number {
  return rateLimit(`apikey:${apiKeyId}`, { limit: API_RATE_LIMIT, windowMs: API_RATE_WINDOW_MS });
}

export function attachRateLimitHeader(res: NextResponse, remaining: number): NextResponse {
  res.headers.set("X-RateLimit-Remaining", String(Math.max(remaining, 0)));
  return res;
}

export { RateLimitError };
