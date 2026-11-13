/**
 * Gemeinsamer Rahmen der Konto-Sicherheitsrouten (`/api/account/totp/*`, Phase 17d):
 * Sitzungspruefung, IP-Bremse `account-security:<ip>` (10 je 5 Minuten, Zaehlung je Anfrage),
 * `cache-control: no-store` und einheitliche Fehlerbehandlung ohne Body-Protokollierung.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/lib/auth/server";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { IP_RATE_LIMIT, IP_RATE_WINDOW_MS } from "@/domain/auth/attempts";

const NO_STORE = { "cache-control": "no-store" } as const;

export function jsonNoStore(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): NextResponse {
  return NextResponse.json(body, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

export function minutesCeil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

export function lockedResponse(retryAfterMs: number): NextResponse {
  return jsonNoStore(
    { error: `Konto vorübergehend gesperrt. Bitte in etwa ${minutesCeil(retryAfterMs)} Minute(n) erneut versuchen.` },
    { status: 401, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
  );
}

/** Wandelt Rate-Limit-, Validierungs- und unerwartete Fehler in Antworten um. */
export function errorResponse(e: unknown, label: string, zodMessage: string): NextResponse {
  if (e instanceof RateLimitError) {
    return jsonNoStore(
      { error: "Zu viele Versuche. Bitte später erneut versuchen." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
    );
  }
  if (e instanceof z.ZodError) return jsonNoStore({ error: zodMessage }, { status: 400 });
  console.error(`${label}:`, e instanceof Error ? e.message : "Fehler");
  return jsonNoStore({ error: "Anfrage fehlgeschlagen." }, { status: 400 });
}

/** Sitzung + IP-Bremse; `Response` bei Ablehnung, sonst Konto-ID und IP. */
export async function guardAccountRoute(req: Request): Promise<{ userId: string; ip: string | undefined } | NextResponse> {
  const userId = await getCurrentUserId();
  if (!userId) return jsonNoStore({ error: "Nicht angemeldet." }, { status: 401 });
  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    rateLimit(`account-security:${ip ?? "unknown"}`, { limit: IP_RATE_LIMIT, windowMs: IP_RATE_WINDOW_MS });
  } catch (e) {
    return errorResponse(e, "account-security", "");
  }
  return { userId, ip };
}
