import { NextResponse } from "next/server";
import { setSession } from "@/lib/auth/server";
import { disableTotp } from "@/domain/auth/two-factor";
import { errorResponse, guardAccountRoute, jsonNoStore, lockedResponse } from "@/lib/http/account-route";

export const runtime = "nodejs";

/** POST /api/account/totp/disable { password, code } — Passwort UND zweiter Faktor (Code oder Wiederherstellungscode). */
export async function POST(req: Request) {
  const guard = await guardAccountRoute(req);
  if (guard instanceof NextResponse) return guard;
  try {
    const body: unknown = await req.json();
    const result = await disableTotp(guard.userId, body, { ip: guard.ip });
    if (result.status === "ok") {
      await setSession(guard.userId);
      return jsonNoStore({ ok: true });
    }
    if (result.status === "locked") return lockedResponse(result.retryAfterMs);
    return jsonNoStore({ error: "Passwort oder Code ist falsch." }, { status: 401 });
  } catch (e) {
    return errorResponse(e, "account/totp/disable", "Bitte Passwort und Code eingeben.");
  }
}
