import { NextResponse } from "next/server";
import { enableTotp, TotpAlreadyEnabledError } from "@/domain/auth/two-factor";
import { errorResponse, guardAccountRoute, jsonNoStore } from "@/lib/http/account-route";

export const runtime = "nodejs";

/** POST /api/account/totp/enable { code } — Aktivierung; die Wiederherstellungscodes erscheinen nur in dieser Antwort. */
export async function POST(req: Request) {
  const guard = await guardAccountRoute(req);
  if (guard instanceof NextResponse) return guard;
  try {
    const body: unknown = await req.json();
    const result = await enableTotp(guard.userId, body);
    if (result.status === "ok") return jsonNoStore({ recoveryCodes: result.recoveryCodes });
    if (result.status === "no_pending_setup") return jsonNoStore({ error: "Die Einrichtung wurde nicht gestartet oder ist abgelaufen. Bitte neu beginnen." }, { status: 400 });
    return jsonNoStore({ error: "Code ist falsch." }, { status: 400 });
  } catch (e) {
    if (e instanceof TotpAlreadyEnabledError) return jsonNoStore({ error: e.message }, { status: 409 });
    return errorResponse(e, "account/totp/enable", "Bitte den 6-stelligen Code eingeben.");
  }
}
