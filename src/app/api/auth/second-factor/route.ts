/**
 * POST /api/auth/second-factor { code } — zweiter Schritt der Anmeldung (Phase 17d).
 * Voraussetzung ist das Zwischen-Cookie `oig_mfa` aus /api/auth/login; erst hier entsteht
 * die Sitzung. Die IP-Bremse `login:<ip>` liegt in `verifySecondFactor` (gemeinsam mit der
 * Passwortanmeldung).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { clearPendingMfa, readPendingMfa, setSession } from "@/lib/auth/server";
import { verifySecondFactor } from "@/domain/auth/two-factor";
import { RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";

export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: Request) {
  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    const body: unknown = await req.json();
    const pending = await readPendingMfa();
    if (!pending) {
      return NextResponse.json({ error: "Anmeldung abgelaufen. Bitte erneut anmelden." }, { status: 401, headers: NO_STORE });
    }
    const result = await verifySecondFactor(pending, body, { ip });

    if (result.status === "ok") {
      await clearPendingMfa();
      await setSession(result.userId);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    if (result.status === "expired") {
      await clearPendingMfa();
      return NextResponse.json({ error: "Anmeldung abgelaufen. Bitte erneut anmelden." }, { status: 401, headers: NO_STORE });
    }
    if (result.status === "locked") {
      const minutes = Math.max(1, Math.ceil(result.retryAfterMs / 60_000));
      return NextResponse.json(
        { error: `Konto vorübergehend gesperrt. Bitte in etwa ${minutes} Minute(n) erneut versuchen.` },
        { status: 401, headers: { ...NO_STORE, "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) } },
      );
    }
    return NextResponse.json({ error: "Code ist falsch." }, { status: 401, headers: NO_STORE });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { error: "Zu viele Anmeldeversuche von dieser Adresse. Bitte später erneut versuchen." },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    if (e instanceof z.ZodError || e instanceof SyntaxError) {
      return NextResponse.json({ error: "Bitte den Code eingeben." }, { status: 400, headers: NO_STORE });
    }
    console.error("auth/second-factor:", e instanceof Error ? e.message : "Fehler");
    return NextResponse.json({ error: "Anmeldung fehlgeschlagen." }, { status: 400, headers: NO_STORE });
  }
}
