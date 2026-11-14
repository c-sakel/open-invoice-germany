/**
 * Query-Parameter der REST-Listen als Objekt fuer die Zod-Schemas der Domain. Die genannten
 * Schluessel werden von "true"/"false" bzw. "1"/"0" in boolean gewandelt (z.boolean() akzeptiert keinen
 * String); jeder andere Wert bleibt unveraendert und wird vom Schema als Fehler gemeldet.
 */
export function queryObject(sp: URLSearchParams, booleans: readonly string[]): Record<string, unknown> {
  return coerceBooleans(Object.fromEntries(sp), booleans);
}

/** "true"/"1" -> true, "false"/"0" -> false (nicht destruktiv: andere Werte bleiben und werden vom Schema gemeldet). */
export function coerceBooleans(raw: Record<string, unknown>, booleans: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const key of booleans) {
    if (out[key] === "true" || out[key] === "1") out[key] = true;
    else if (out[key] === "false" || out[key] === "0") out[key] = false;
  }
  return out;
}
