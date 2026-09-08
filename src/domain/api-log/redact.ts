/**
 * Reine Helfer fuer das Anfrageprotokoll (Phase 12d) — kein DB-Zugriff, kein Request:
 * Schwaerzen verdaechtiger JSON-Schluessel, Kuerzen auf 2 KB, Ausschluss der Pfade, die
 * nichts zum Debuggen beitragen (Doku/OpenAPI/ping) oder eine Rekursion ausloesen wuerden
 * (die Protokoll-Route selbst). Der Authorization-HEADER wird nirgends gespeichert — er
 * kommt gar nicht erst in diese Datei; das Muster deckt nur ein gleichnamiges JSON-Feld ab.
 */
export const MAX_BODY_BYTES = 2048;
export const REDACTED = "[redaktiert]";
export const SECRET_KEY_PATTERN = /(secret|token|password|passwort|api[_-]?key|authorization|iban|bic)/i;

/** Pfade ohne Protokolleintrag — exakt ODER als Praefix mit "/". */
export const UNLOGGED_PATHS: readonly string[] = ["/api/docs", "/api/v1/openapi.json", "/api/v1/ping", "/api/v1/ApiRequestLog"];

export function shouldLogPath(pathname: string): boolean {
  return !UNLOGGED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactJson(v);
  }
  return out;
}

/**
 * Schwaerzt (sofern JSON) und kuerzt. Gekuerzt wird ZEICHENweise gegen die Byte-Grenze —
 * ein Schnitt mitten in einem Mehrbyte-Zeichen wuerde ein Ersatzzeichen erzeugen.
 */
export function prepareBody(raw: string | null | undefined): { text: string | null; truncated: boolean } {
  if (!raw) return { text: null, truncated: false };
  let text = raw;
  try {
    text = JSON.stringify(redactJson(JSON.parse(raw)));
  } catch {
    // kein JSON -> unveraendert (aber gekuerzt) uebernehmen
  }
  if (Buffer.byteLength(text, "utf8") <= MAX_BODY_BYTES) return { text, truncated: false };
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > MAX_BODY_BYTES) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}
