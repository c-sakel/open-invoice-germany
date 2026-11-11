/**
 * GET /api/health — oeffentlicher Health-Check (Phase 16a, Task 8) fuer Monitoring und Docker.
 * Liefert ausschliesslich `{"status":"ok"}` (200) bzw. `{"status":"error"}` (503) — keine Details,
 * keine Versionen, keine Zaehler. Kein Rate-Limit; das DB-Ergebnis wird serverseitig 5 s
 * zwischengespeichert (DB hoechstens alle 5 s gefragt), die Antwort selbst ist no-store.
 */
import { NextResponse } from "next/server";
import { cachedDbStatus } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const ok = await cachedDbStatus();
  return NextResponse.json({ status: ok ? "ok" : "error" }, { status: ok ? 200 : 503, headers: NO_STORE });
}
