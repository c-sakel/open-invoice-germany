/**
 * POST /api/auth/password-reset/confirm { token, newPassword, newPasswordRepeat, code? } —
 * Passwort-Reset einloesen (Phase 17d). Meldet nicht automatisch an.
 */
import { jsonNoStore, errorResponse, lockedResponse } from "@/lib/http/account-route";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { confirmPasswordReset } from "@/domain/auth/password-reset";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    const body: unknown = await req.json();
    const result = await confirmPasswordReset(body, { ip });
    switch (result.status) {
      case "ok":
        return jsonNoStore({ ok: true });
      case "second_factor_required":
        return jsonNoStore({ error: "Bitte den Code aus deiner Authenticator-App oder einen Wiederherstellungscode eingeben.", secondFactorRequired: true }, { status: 400 });
      case "invalid_code":
        return jsonNoStore({ error: "Code ist falsch." }, { status: 401 });
      case "locked":
        return lockedResponse(result.retryAfterMs);
      default:
        return jsonNoStore({ error: "Der Link ist ungültig oder abgelaufen." }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof SyntaxError) return jsonNoStore({ error: "Der Link ist ungültig oder abgelaufen." }, { status: 400 });
    return errorResponse(e, "auth/password-reset/confirm", "Bitte alle Felder korrekt ausfüllen (neues Passwort mind. 10 Zeichen, Wiederholung muss übereinstimmen).");
  }
}
