/**
 * Entscheidet, ob das Session-Cookie das `Secure`-Flag bekommt.
 *
 * Hintergrund: Browser speichern Secure-Cookies ueber unverschluesseltes HTTP nur fuer
 * `localhost`. Ein festes `secure: NODE_ENV === "production"` sperrte deshalb jeden aus, der
 * `npm start` ohne TLS im LAN betreibt (Login ok, Cookie verworfen, Redirect-Schleife auf
 * /login). Massgeblich ist daher das Protokoll der Anfrage.
 *
 * Reihenfolge: 1. `SESSION_COOKIE_SECURE=true|false` (expliziter Betreiber-Override),
 * 2. `x-forwarded-proto` des Reverse-Proxys, 3. sonst unverschluesselt -> kein Secure.
 */
export function isSecureRequest(headers: Pick<Headers, "get">, env: Record<string, string | undefined> = process.env): boolean {
  const override = env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (override === "true" || override === "1") return true;
  if (override === "false" || override === "0") return false;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}
