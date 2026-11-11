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

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  const ip = clientIpFromHeaders(req.headers) ?? "unknown";
  try {
    rateLimit(`health:${ip}`, { limit: 60, windowMs: 60_000 });
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
