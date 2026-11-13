/**
 * POST /api/auth/password-reset/request { email } — Passwort-Reset anfordern (Phase 17d).
 * Vor der Antwort laufen NUR Schema-Validierung und IP-Bremse (keine Datenbank); die gesamte
 * kontoabhaengige Arbeit (Lookup, Kontolimit, Token, Protokoll, Mailaufbau und -versand) laeuft
 * in `after()`. Dadurch ist Antwort UND Antwortzeit fuer bekannte und unbekannte Adressen gleich. Der Link kommt nur aus `APP_BASE_URL`, nie aus den Headern.
 */
import { after } from "next/server";
import { jsonNoStore, errorResponse } from "@/lib/http/account-route";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { passwordResetRequestSchema } from "@/schemas/auth";
import { deliverPasswordResetMail, enforceResetIpLimit, requestPasswordReset } from "@/domain/auth/password-reset";

export const runtime = "nodejs";

const MESSAGE = "Wenn ein Konto mit dieser Adresse existiert, ist eine E-Mail mit einem Link unterwegs. Der Link gilt 30 Minuten.";

export async function POST(req: Request) {
  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    const body: unknown = await req.json();
    passwordResetRequestSchema.parse(body);
    enforceResetIpLimit(ip);
    after(async () => {
      try {
        const { mail } = await requestPasswordReset(body, { ip, ipLimitChecked: true });
        if (mail) await deliverPasswordResetMail(mail);
      } catch (e) {
        console.error("auth/password-reset/request (nachgelagert):", e instanceof Error ? e.name : "Fehler");
      }
    });
    return jsonNoStore({ ok: true, message: MESSAGE });
  } catch (e) {
    if (e instanceof SyntaxError) return jsonNoStore({ error: "Bitte eine gültige E-Mail-Adresse eingeben." }, { status: 400 });
    return errorResponse(e, "auth/password-reset/request", "Bitte eine gültige E-Mail-Adresse eingeben.");
  }
}
