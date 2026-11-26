import { z } from "zod";

// Content-Security-Policy fuer Seiten (nicht fuer Downloads unter /api/..., die eine eigene,
// strengere Policy tragen). Kein Nonce: Seiten bleiben statisch, daher 'unsafe-inline' fuer Skripte
// (Next.js-Bootstrap). Die Policy begrenzt vor allem Rahmen, Formularziele, Plugins und Basis-URL.
export const cspModeSchema = z.enum(["enforce", "report-only", "off"]);
export type CspMode = z.infer<typeof cspModeSchema>;

let warned = false;

/** Modus aus `SECURITY_CSP` (Standard enforce). Ungueltige Werte ergeben enforce plus einmal eine Warnung. */
export function cspModeFromEnv(raw: string | undefined = process.env.SECURITY_CSP): CspMode {
  if (raw === undefined || raw.trim() === "") return "enforce";
  const parsed = cspModeSchema.safeParse(raw.trim().toLowerCase());
  if (parsed.success) return parsed.data;
  if (!warned) {
    warned = true;
    console.warn("SECURITY_CSP hat einen ungueltigen Wert, es gilt enforce (erlaubt: enforce, report-only, off).");
  }
  return "enforce";
}

export function buildCsp({ dev }: { dev: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "frame-src 'self' blob:",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // https: erlaubt die 303-Weiterleitung der Bezahlseite zum Zahlungsanbieter.
    "form-action 'self' https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/** Header-Name je Modus; `null` bei `off` (kein Header). */
export function cspHeaderName(mode: CspMode): string | null {
  if (mode === "off") return null;
  return mode === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

/** Setzt die CSP auf die Antwort, wenn der Pfad eine Seite oder /api/docs ist. */
export function applyCsp(res: Response, pathname: string): void {
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const isDocs = pathname === "/api/docs" || pathname.startsWith("/api/docs/");
  if (isApi && !isDocs) return;
  const name = cspHeaderName(cspModeFromEnv());
  if (!name) return;
  res.headers.set(name, buildCsp({ dev: process.env.NODE_ENV !== "production" }));
}
