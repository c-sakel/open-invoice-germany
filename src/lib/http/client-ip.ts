import { z } from "zod";

/**
 * Client-IP fuer Rate-Limits und Anzeige (Angebotsannahme, Anmeldung, Konto-Routen).
 * Die Quelle ist ueber `CLIENT_IP_SOURCE` konfigurierbar, weil jeder dieser Header nur
 * hinter dem passenden Proxy vertrauenswuerdig ist:
 *  - `cf`        nur `cf-connecting-ip` (Origin hinter Cloudflare, nur fuer dessen IPs erreichbar)
 *  - `x-real-ip` nur `x-real-ip` (ein Reverse-Proxy, der ihn selbst setzt/ueberschreibt)
 *  - `xff`       Eintrag aus `x-forwarded-for` von RECHTS: `TRUSTED_PROXY_COUNT` (Default 1)
 *                Proxys haengen an; der Eintrag davor stammt vom letzten vertrauten Proxy
 *  - `legacy`    (Default) `cf-connecting-ip`, sonst erster `x-forwarded-for`-Eintrag. Beide
 *                sind faelschbar, wenn der Origin direkt erreichbar ist.
 * Unbekannter Wert -> `legacy` mit einmaliger Warnung. Fehlt die Quelle: `null`.
 */
const sourceSchema = z.enum(["cf", "x-real-ip", "xff", "legacy"]);
const proxyCountSchema = z.coerce.number().int().min(1).max(10);

export type ClientIpSource = z.infer<typeof sourceSchema>;

let warned = false;

function configuredSource(): ClientIpSource {
  const raw = process.env.CLIENT_IP_SOURCE?.trim();
  if (!raw) return "legacy";
  const parsed = sourceSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  if (!warned) {
    warned = true;
    console.warn("CLIENT_IP_SOURCE hat einen unbekannten Wert (erlaubt: cf, x-real-ip, xff, legacy) — es gilt legacy.");
  }
  return "legacy";
}

function trustedProxyCount(): number {
  const raw = process.env.TRUSTED_PROXY_COUNT?.trim();
  if (!raw) return 1;
  const parsed = proxyCountSchema.safeParse(raw);
  return parsed.success ? parsed.data : 1;
}

function clean(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function clientIpFromHeaders(headers: Headers): string | null {
  switch (configuredSource()) {
    case "cf":
      return clean(headers.get("cf-connecting-ip"));
    case "x-real-ip":
      return clean(headers.get("x-real-ip"));
    case "xff": {
      const entries = (headers.get("x-forwarded-for") ?? "")
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e !== "");
      return entries[entries.length - trustedProxyCount()] ?? null;
    }
    case "legacy": {
      const cf = clean(headers.get("cf-connecting-ip"));
      if (cf) return cf;
      const xff = headers.get("x-forwarded-for");
      return xff ? clean(xff.split(",")[0]) : null;
    }
  }
}
