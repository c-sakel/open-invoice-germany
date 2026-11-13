/**
 * POST /api/auth/password-reset/request { email } — Passwort-Reset anfordern (Phase 17d).
 * Antwort fuer JEDE gueltige Anfrage byte-gleich (keine Konto-Aufzaehlung); die Mail geht erst
 * nach der Antwort raus (`after()`). Der Link kommt nur aus `APP_BASE_URL`, nie aus den Headern.
 */
import { after } from "next/server";
import { jsonNoStore, errorResponse } from "@/lib/http/account-route";
import { clientIpFromHeaders } from "@/lib/http/client-ip";
import { deliverPasswordResetMail, requestPasswordReset } from "@/domain/auth/password-reset";

export const runtime = "nodejs";

const MESSAGE = "Wenn ein Konto mit dieser Adresse existiert, ist eine E-Mail mit einem Link unterwegs. Der Link gilt 30 Minuten.";

export async function POST(req: Request) {
  const ip = clientIpFromHeaders(req.headers) ?? undefined;
  try {
    const body: unknown = await req.json();
    const { mail } = await requestPasswordReset(body, { ip });
    if (mail) after(() => deliverPasswordResetMail(mail));
    return jsonNoStore({ ok: true, message: MESSAGE });
  } catch (e) {
    if (e instanceof SyntaxError) return jsonNoStore({ error: "Bitte eine gültige E-Mail-Adresse eingeben." }, { status: 400 });
    return errorResponse(e, "auth/password-reset/request", "Bitte eine gültige E-Mail-Adresse eingeben.");
  }
}
