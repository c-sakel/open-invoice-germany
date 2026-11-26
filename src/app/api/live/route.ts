/**
 * GET /api/live — oeffentliche Liveness-Pruefung (Kubernetes livenessProbe) OHNE Datenbank.
 * Antwortet, solange der Prozess Anfragen annimmt. Eine nicht erreichbare Datenbank darf den Pod
 * nicht neu starten lassen; dafuer gibt es die Readiness-Pruefung /api/health.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
