/**
 * POST /api/auth/password — eigenes Passwort aendern (Phase 14a, Task 9, R12).
 * Nur fuer den ANGEMELDETEN Nutzer (Session-Cookie, kein Bearer-Token — Konto-Passwoerter
 * sind kein REST-v1-/MCP-Konzept, siehe login/setup). Bei Erfolg wird NUR das Cookie des
 * aktuellen Browsers erneuert (`setSession`) — jede andere Sitzung wird beim naechsten
 * Zugriff verworfen (`src/lib/auth/server.ts#userIdFromToken`).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId, setSession } from "@/lib/auth/server";
import { changePassword } from "@/domain/auth/login";
import { RateLimitError } from "@/lib/rate-limit";
import { clientIpFromHeaders } from "@/lib/http/client-ip";

export const runtime = "nodejs";

/** Minuten, aufgerundet — fuer die Sperrmeldung an den Nutzer (analog auth/login/route.ts). */
function minutesCeil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

export async function POST(req: Request) {
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    const body: unknown = await req.json();
    const result = await changePassword(userId, body, { ip });

    if (result.status === "ok") {
      await setSession(userId);
      return NextResponse.json({ ok: true });
    }

    if (result.status === "locked") {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      return NextResponse.json(
        { error: `Konto vorübergehend gesperrt. Bitte in etwa ${minutesCeil(result.retryAfterMs)} Minute(n) erneut versuchen.` },
        { status: 401, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    // status === "invalid_current_password"
    return NextResponse.json({ error: "Aktuelles Passwort ist falsch." }, { status: 401 });
  } catch (e) {
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { error: "Zu viele Versuche. Bitte später erneut versuchen." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(e.retryAfterMs / 1000)) } },
      );
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Bitte alle Felder korrekt ausfüllen (neues Passwort mind. 10 Zeichen, Wiederholung muss übereinstimmen)." },
        { status: 400 },
      );
    }
    console.error("auth/password:", e);
    return NextResponse.json({ error: "Passwort konnte nicht geändert werden." }, { status: 400 });
  }
}
