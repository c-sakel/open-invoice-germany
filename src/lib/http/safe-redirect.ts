/**
 * Offene-Weiterleitung-Schutz (Phase 17d): nur relative Pfade der eigenen Instanz.
 * Erlaubt "/…"; nie "//…", "/\\…", absolute URLs, Steuerzeichen.
 */
export function safeRedirectPath(from: string | null | undefined, fallback: string = "/rechnungen"): string {
  if (typeof from !== "string" || from.length === 0) return fallback;
  if (!from.startsWith("/")) return fallback;
  if (from.startsWith("//") || from.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(from)) return fallback;
  return from;
}
