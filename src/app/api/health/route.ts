/**
 * GET /api/health — oeffentlicher Health-Check (Phase 16a, Task 8) fuer Monitoring und Docker.
 * Liefert ausschliesslich `{"status":"ok"}` (200) bzw. `{"status":"error"}` (503) — keine Details,
 * keine Versionen, keine Zaehler. Rate-Limit je IP (60/Minute), nie zwischengespeichert.
 */
import { NextResponse } from "next/server";
import { checkDb } from "@/lib/health";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  const ip = clientIpFromHeaders(req.headers);
  try {
    // Ohne Client-IP-Header (Docker-HEALTHCHECK per Loopback, lokale Pruefungen) wird nicht
    // begrenzt: ein Sammel-Bucket wuerde den Healthcheck mit beliebigen Aufrufern teilen.
    // Ueber den Reverse-Proxy kommende Anfragen tragen immer cf-connecting-ip/x-forwarded-for.
    if (ip !== null && !LOOPBACK.has(ip)) rateLimit(`health:${ip}`, { limit: 60, windowMs: 60_000 });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { status: "error" },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) } },
      );
    }
    throw e;
  }
  const ok = await checkDb();
  return NextResponse.json({ status: ok ? "ok" : "error" }, { status: ok ? 200 : 503, headers: NO_STORE });
}
