import { NextResponse } from "next/server";
import { z } from "zod";
import { setPendingMfa, setSession } from "@/lib/auth/server";
import { attemptLogin } from "@/domain/auth/login";
import { RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";

export const runtime = "nodejs";

/** Einheitliche Antwort fuer "invalid" UND "locked": kein Existenz-/Sperr-Leak, kein Retry-After. */
const LOGIN_FAILED_MESSAGE =
  "Anmeldung fehlgeschlagen. Nach mehreren Fehlversuchen ist die Anmeldung vorübergehend gesperrt — bitte später erneut versuchen.";

export async function POST(req: Request) {
  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    const body: unknown = await req.json();
    const result = await attemptLogin(body, { ip });

    if (result.status === "ok") {
      await setSession(result.userId);
      return NextResponse.json({ ok: true });
    }

    if (result.status === "second_factor") {
      // Passwort stimmt, zweiter Faktor steht aus: nur Zwischen-Cookie, keine Sitzung.
      await setPendingMfa(result.userId);
      return NextResponse.json({ twoFactor: true });
    }

    // "invalid" (unbekannte E-Mail, falsches Passwort) und "locked" (Konto gesperrt) sind fuer
    // nicht angemeldete Clients nicht unterscheidbar: gleicher Status, gleicher Text, keine Restzeit.
    return NextResponse.json({ error: LOGIN_FAILED_MESSAGE }, { status: 401 });
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
