/**
 * Basis-URL der Instanz fuer oeffentliche Links (Angebotsannahme, Phase 3b).
 * `APP_BASE_URL` (optional, `.env.example`) hat Vorrang; ohne Env-Wert wird aus den
 * Request-Headern rekonstruiert (`x-forwarded-proto` + `host`, Fallback `https`).
 */
export function resolveBaseUrl(headers: Headers): string {
  const fromEnv = process.env.APP_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const host = headers.get("host") ?? "localhost:3000";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
