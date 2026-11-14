import { NextResponse } from "next/server";
import { z } from "zod";
import { bulkCancelSchema } from "@/schemas";
import { cancelInvoicesBulk } from "@/domain/invoice/bulk-cancel";
import { getActiveOrg } from "@/lib/org";
import { getCurrentUserId } from "@/lib/auth/server";
import { rateLimit, RateLimitError } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Serverseitige Bestaetigung: nur ein ausdruecklich bestaetigter Aufruf (Dialog) storniert. */
const bulkCancelRequestSchema = bulkCancelSchema.extend({ confirm: z.literal(true) });

const NO_STORE = { "cache-control": "no-store" };

/** Sammel-Storno (18c): jeder Beleg ueber den Einzelstorno, seriell, Ergebnisbericht je Beleg. */
export async function POST(req: Request) {
  try {
    if (!req.headers.get("content-type")?.startsWith("application/json")) {
      return NextResponse.json({ error: "Bitte JSON senden." }, { status: 415, headers: NO_STORE });
    }
    const org = await getActiveOrg();
    rateLimit(`bulk-cancel:${org.id}`, { limit: 10, windowMs: 60_000 });
    const parsed = bulkCancelRequestSchema.parse(await req.json());
    const actor = (await getCurrentUserId()) ?? "system";
    const result = await cancelInvoicesBulk(org.id, { ids: parsed.ids, reason: parsed.reason }, { actor });
    return NextResponse.json(result, { headers: NO_STORE });
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
    console.error("[bulk-cancel] Route", e);
    return NextResponse.json({ error: "Sammel-Storno fehlgeschlagen." }, { status: 500, headers: NO_STORE });
  }
}
