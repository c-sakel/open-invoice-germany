import { NextResponse } from "next/server";
import { z } from "zod";
import { getCancelPreviews } from "@/domain/invoice/bulk-cancel";
import { getActiveOrg } from "@/lib/org";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

/** Vorschau je Beleg fuer den Sammel-Storno-Dialog — nur lesend, mandantengeprueft. */
export async function POST(req: Request) {
  try {
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
      return NextResponse.json({ error: "Bitte JSON senden." }, { status: 415, headers: NO_STORE });
    }
    const org = await getActiveOrg();
    rateLimit(`bulk-cancel-preview:${org.id}`, { limit: 30, windowMs: 60_000 });
    const body: unknown = await req.json();
    return NextResponse.json(await getCancelPreviews(org.id, body), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Validierung fehlgeschlagen", issues: e.issues }, { status: 400, headers: NO_STORE });
    }
    if (e instanceof SyntaxError) return NextResponse.json({ error: "Ungültiges JSON im Request-Body." }, { status: 400, headers: NO_STORE });
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { error: "Zu viele Anfragen — bitte kurz warten." },
        { status: 429, headers: { ...NO_STORE, "retry-after": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    console.error("[bulk-cancel] Vorschau", e);
    return NextResponse.json({ error: "Vorschau fehlgeschlagen." }, { status: 500, headers: NO_STORE });
  }
}
