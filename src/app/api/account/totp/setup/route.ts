import { NextResponse } from "next/server";
import { beginTotpSetup, TotpAlreadyEnabledError } from "@/domain/auth/two-factor";
import { SecretsUnavailableError } from "@/lib/crypto/secrets";
import { errorResponse, guardAccountRoute, jsonNoStore } from "@/lib/http/account-route";

export const runtime = "nodejs";

/** POST /api/account/totp/setup — neues Geheimnis erzeugen (noch nicht aktiv); Antwort enthaelt das Geheimnis, daher no-store. */
export async function POST(req: Request) {
  const guard = await guardAccountRoute(req);
  if (guard instanceof NextResponse) return guard;
  try {
    return jsonNoStore(await beginTotpSetup(guard.userId));
  } catch (e) {
    if (e instanceof TotpAlreadyEnabledError) return jsonNoStore({ error: e.message }, { status: 409 });
    if (e instanceof SecretsUnavailableError) {
      return jsonNoStore({ error: "AUTH_SECRET fehlt: Die Zwei-Faktor-Anmeldung kann ohne dieses Geheimnis nicht eingerichtet werden." }, { status: 409 });
    }
    return errorResponse(e, "account/totp/setup", "Ungültige Anfrage.");
  }
}
