/**
 * Auth-Guard fuer die oeffentlich erreichbaren Cron-Endpunkte (`/api/cron/*`, Phase 6,
 * Fix-Welle B3). Vorher: `authorized()` gab bei fehlendem `CRON_SECRET` `true` zurueck
 * ("erlaubt", solange niemand ein Secret konfiguriert hat) — auf einem oeffentlichen
 * Deployment ohne gesetztes Secret war die Route damit anonym erreichbar und loeste
 * Kundenkommunikation aus (Mahn-/Abo-Versand). Fail-closed: OHNE gesetztes `CRON_SECRET`
 * ist die Route grundsaetzlich gesperrt (503), nicht offen. `/api/cron` ist bewusst von der
 * Session-Pruefung ausgenommen (`src/proxy.ts`) — dieser Guard ist der einzige Schutz.
 * Das Secret wird NUR als `Authorization: Bearer`-Header akzeptiert (ein Query-Parameter
 * landet in Zugriffs- und Proxy-Protokollen) und zeitkonstant verglichen (SHA-256 beider
 * Seiten, damit `timingSafeEqual` bei beliebigen Laengen nicht wirft).
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type CronAuthResult = "ok" | "unset" | "unauthorized";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function checkCronAuth(req: Request): CronAuthResult {
  const secret = process.env.CRON_SECRET;
  if (!secret) return "unset";
  const auth = req.headers.get("authorization");
  if (!auth) return "unauthorized";
  return timingSafeEqual(digest(auth), digest(`Bearer ${secret}`)) ? "ok" : "unauthorized";
}
