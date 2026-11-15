/**
 * Formular-Kodierung in Klammer-Notation (application/x-www-form-urlencoded) fuer Anbieter ohne JSON-Body.
 * Reihenfolge der Schluessel bleibt wie im Eingabeobjekt; `undefined` entfaellt; leere Arrays entfallen.
 */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function walk(prefix: string, value: unknown, out: string[]): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    out.push(`${enc(prefix)}=${enc(value)}`);
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Formularwert muss endlich sein.");
    out.push(`${enc(prefix)}=${enc(String(value))}`);
  } else if (typeof value === "boolean") {
    out.push(`${enc(prefix)}=${value ? "true" : "false"}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walk(`${prefix}[${i}]`, v, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(`${prefix}[${k}]`, v, out);
  } else {
    throw new Error("Formularwert hat einen nicht unterstuetzten Typ.");
  }
}

export function formEncode(input: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(input)) walk(k, v, out);
  return out.join("&");
}
