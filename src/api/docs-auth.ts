/**
 * Session-ODER-Bearer-Pruefung fuer `/api/docs` (Swagger-UI) und `GET
 * /api/v1/openapi.json` (Phase 10, Task 4, plan-header.md: "Swagger-UI /api/docs
 * (Session ODER Key)") — beide sollen sowohl aus dem Browser (Session-Cookie, Swagger
 * UI selbst laedt die Spec per `fetch`) als auch von einem externen Werkzeug mit
 * API-Schluessel (Bearer) erreichbar sein. Bewusst KEIN `withApi` (src/api/auth.ts) —
 * das erzwingt ausschliesslich Bearer, kein Session-Fallback.
 */
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { verifyApiToken } from "@/domain/api-key/verify";

function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** `true`, wenn entweder ein gueltiger Bearer-API-Schluessel ODER eine gueltige
 *  Session vorliegt. Ein ungueltiger Bearer-Token fuehrt NICHT sofort zu `false` —
 *  es wird zusaetzlich noch die Session geprueft (z. B. ein im Browser gespeicherter,
 *  abgelaufener Testtoken soll eine gueltige Session nicht verdecken). */
export async function requireSessionOrApiKey(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    try {
      await verifyApiToken(auth.slice("Bearer ".length).trim());
      return true;
    } catch {
      // faellt durch auf die Session-Pruefung, siehe Kommentar oben.
    }
  }
  const userId = await verifySessionToken(readSessionCookie(req));
  return !!userId;
}
