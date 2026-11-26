import { NextResponse } from "next/server";
import { getActiveOrg } from "@/lib/org";
import { NotFoundError } from "@/domain/errors";
import { AuthRequiredError, requireSessionActor, authRequiredResponse } from "@/lib/auth/require-session";
import { RateLimitError, rateLimit } from "@/lib/rate-limit";
import { lookupQuerySchema } from "@/schemas/lookup";

const NO_STORE = { "cache-control": "no-store" } as const;
const LOOKUP_LIMIT = 240;
const LOOKUP_WINDOW_MS = 60_000;

/** Gemeinsamer Rahmen der Such-Endpunkte: Organisation, Bremse je Organisation, feste Fehlertexte. */
export async function runLookup(
  name: string,
  req: Request | null,
  fn: (orgId: string, rawQuery: Record<string, string | undefined>) => Promise<unknown>,
): Promise<Response> {
  try {
    await requireSessionActor();
    const org = await getActiveOrg();
    rateLimit(`lookup:${org.id}`, { limit: LOOKUP_LIMIT, windowMs: LOOKUP_WINDOW_MS });
    let rawQuery: Record<string, string | undefined> = {};
    if (req) {
      rawQuery = parseLookupParams(req);
      const parsed = lookupQuerySchema.safeParse(rawQuery);
      if (!parsed.success) {
        return NextResponse.json({ error: "Ungültige Suchanfrage", details: parsed.error.flatten() }, { status: 400, headers: NO_STORE });
      }
    }
    return NextResponse.json(await fn(org.id, rawQuery), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof AuthRequiredError) return authRequiredResponse();
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { error: "Zu viele Anfragen" },
        { status: 429, headers: { ...NO_STORE, "retry-after": String(Math.max(1, Math.ceil(e.retryAfterMs / 1000))) } },
      );
    }
    if (e instanceof NotFoundError) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404, headers: NO_STORE });
    console.error(`GET ${name}:`, e);
    return NextResponse.json({ error: "Interner Fehler" }, { status: 500, headers: NO_STORE });
  }
}

function parseLookupParams(req: Request): Record<string, string | undefined> {
  const sp = new URL(req.url).searchParams;
  return { q: sp.get("q") ?? "", limit: sp.get("limit") ?? undefined, ids: sp.get("ids") ?? undefined };
}
