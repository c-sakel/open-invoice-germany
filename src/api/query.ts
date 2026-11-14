/**
 * Query-Parameter der REST-Listen als Objekt fuer die Zod-Schemas der Domain. Die genannten
 * Schluessel werden von "true"/"false" in boolean gewandelt (z.boolean() akzeptiert keinen
 * String); jeder andere Wert bleibt unveraendert und wird vom Schema als Fehler gemeldet.
 */
export function queryObject(sp: URLSearchParams, booleans: readonly string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = Object.fromEntries(sp);
  for (const key of booleans) {
    if (raw[key] === "true") raw[key] = true;
    else if (raw[key] === "false") raw[key] = false;
  }
  return raw;
}
