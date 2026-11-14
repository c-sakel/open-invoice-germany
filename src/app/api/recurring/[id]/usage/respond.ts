/** Gemeinsame Antworten der Sitzungs-Routen fuer Verbrauch (Phase 18f, Task 8). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { UsageError } from "@/domain/recurring/usage-error";

const NO_STORE = { "cache-control": "no-store" };

export function jsonRequired(req: Request): NextResponse | null {
  if (req.headers.get("content-type")?.startsWith("application/json")) return null;
  return NextResponse.json({ error: "Bitte JSON senden." }, { status: 415, headers: NO_STORE });
}

export function ok(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Felder -> erste Meldung je Feld, damit das Formular sie am Feld anzeigen kann. */
function fieldErrors(e: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of e.issues) {
    const key = String(issue.path[0] ?? "_");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export function usageErrorResponse(e: unknown, label: string): NextResponse {
  if (e instanceof UsageError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : 422;
    return NextResponse.json({ error: e.message, code: e.code }, { status, headers: NO_STORE });
  }
  if (e instanceof z.ZodError) {
    const fields = fieldErrors(e);
    return NextResponse.json({ error: Object.values(fields)[0] ?? "Ungültige Eingabe.", fields }, { status: 400, headers: NO_STORE });
  }
  if (e instanceof SyntaxError) return NextResponse.json({ error: "Ungültiges JSON im Request-Body." }, { status: 400, headers: NO_STORE });
  console.error(label, e);
  return NextResponse.json({ error: "Verbrauch konnte nicht gespeichert werden." }, { status: 500, headers: NO_STORE });
}
