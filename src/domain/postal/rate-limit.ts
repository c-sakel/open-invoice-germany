/**
 * Phase 16d — engeres Kontingent fuer Postversand-Aktionen (zusaetzlich zum allgemeinen API-Limit):
 * Angebote/Preise fragen den Briefdienst an, Versand/Storno kosten Geld. Je Organisation, gemeinsam
 * fuer REST und MCP. Wirft RateLimitError (REST 429).
 */
import { rateLimit } from "@/lib/rate-limit";

export const POSTAL_RATE_LIMIT = 30;
export const POSTAL_RATE_WINDOW_MS = 60_000;

export function checkPostalRateLimit(orgId: string): void {
  rateLimit(`postal:${orgId}`, { limit: POSTAL_RATE_LIMIT, windowMs: POSTAL_RATE_WINDOW_MS });
}
