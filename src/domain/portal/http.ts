/**
 * Gemeinsame HTTP-Bausteine des oeffentlichen Kundenportals (Seite und Download-Route).
 */

/** Sicherheitsheader fuer jede Portalantwort: keine Zwischenspeicherung, keine Indexierung, kein Referer. */
export function portalSecurityHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "x-content-type-options": "nosniff",
  };
}
