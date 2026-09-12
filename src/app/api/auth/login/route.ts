import { NextResponse } from "next/server";
import { z } from "zod";
import { setSession } from "@/lib/auth/server";
import { attemptLogin } from "@/domain/auth/login";
import { RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";

export const runtime = "nodejs";

/** Minuten, aufgerundet — fuer die Sperrmeldung an den Nutzer (Retry-After-Header traegt
 *  die exakten Sekunden fuer programmatische Aufrufer). */
function minutesCeil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

export async function POST(req: Request) {
  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    const body: unknown = await req.json();
    const result = await attemptLogin(body, { ip });

    if (result.status === "ok") {
      await setSession(result.userId);
      return NextResponse.json({ ok: true });
    }

    if (result.status === "locked") {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      return NextResponse.json(
        { error: `Konto vorübergehend gesperrt. Bitte in etwa ${minutesCeil(result.retryAfterMs)} Minute(n) erneut versuchen.` },
        { status: 401, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // status === "invalid" — bewusst dieselbe Meldung fuer unbekannte E-Mail UND falsches
    // Passwort (R12: kein Existenz-Leak).
    return NextResponse.json({ error: "E-Mail oder Passwort ist falsch." }, { status: 401 });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { error: "Zu viele Anmeldeversuche von dieser Adresse. Bitte später erneut versuchen." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Bitte E-Mail und Passwort eingeben." }, { status: 400 });
    }
    console.error("auth/login:", e);
    return NextResponse.json({ error: "Anmeldung fehlgeschlagen." }, { status: 400 });
  }
}
