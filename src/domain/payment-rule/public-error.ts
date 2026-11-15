/**
 * Fehlertexte, die nach aussen (REST, MCP, Oberflaeche) gehen: nur feste Hinweise, nie rohe Fehlermeldungen
 * (Mailadressen, Hostnamen, Stacktraces). Die Rohtexte bleiben intern gespeichert und im Server-Log.
 */
import { SEND_UNCLEAR_NOTE } from "./mail";

export const GENERIC_ACTION_ERROR = "Aktion fehlgeschlagen – Details im Server-Protokoll";

const KNOWN_TEXTS = new Set<string>([
  SEND_UNCLEAR_NOTE,
  "Keine Mail-Einstellungen hinterlegt.",
  "Lauf wurde von einem anderen Ausfuehrer uebernommen.",
]);

export function publicErrorText(raw: string | null): string | null {
  if (raw === null) return null;
  if (KNOWN_TEXTS.has(raw)) return raw;
  if (raw.includes(SEND_UNCLEAR_NOTE)) return SEND_UNCLEAR_NOTE;
  return GENERIC_ACTION_ERROR;
}

/** Schritte eines Laufs: das Feld error jedes Schritts wird auf einen festen Hinweis reduziert. */
export function publicSteps(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((s: unknown) => {
    if (typeof s !== "object" || s === null || !("error" in s)) return s;
    const { error, ...rest } = s as { error?: unknown } & Record<string, unknown>;
    return typeof error === "string" ? { ...rest, error: publicErrorText(error) } : rest;
  });
}
