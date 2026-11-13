import { NextResponse } from "next/server";
import { setSession } from "@/lib/auth/server";
import { renewRecoveryCodes } from "@/domain/auth/two-factor";
import { errorResponse, guardAccountRoute, jsonNoStore, lockedResponse } from "@/lib/http/account-route";

export const runtime = "nodejs";

/** POST /api/account/totp/recovery-codes { password, code } — neue Wiederherstellungscodes (die alten verfallen). */
export async function POST(req: Request) {
  const guard = await guardAccountRoute(req);
  if (guard instanceof NextResponse) return guard;
  try {
    const body: unknown = await req.json();
    const result = await renewRecoveryCodes(guard.userId, body, { ip: guard.ip });
    if (result.status === "ok") {
      await setSession(guard.userId);
      return jsonNoStore({ recoveryCodes: result.recoveryCodes });
    }
    if (result.status === "locked") return lockedResponse(result.retryAfterMs);
    return jsonNoStore({ error: "Passwort oder Code ist falsch." }, { status: 401 });
  } catch (e) {
    return errorResponse(e, "account/totp/recovery-codes", "Bitte Passwort und Code eingeben.");
  }
}
