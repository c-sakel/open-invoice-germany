/**
 * Fehlertexte, die nach aussen (REST, MCP, Oberflaeche) gehen: nur feste Hinweise, nie rohe Fehlermeldungen
 * (Mailadressen, Hostnamen, Stacktraces). Die Rohtexte bleiben intern gespeichert und im Server-Log.
 */
import { NO_MAIL_SETTINGS_NOTE, SEND_UNCLEAR_NOTE } from "./mail";

export const GENERIC_ACTION_ERROR = "Aktion fehlgeschlagen – Details im Server-Protokoll";

const KNOWN_TEXTS = new Set<string>([
  SEND_UNCLEAR_NOTE,
  NO_MAIL_SETTINGS_NOTE,
]);

export function publicErrorText(raw: string | null): string | null {
  if (raw === null) return null;
  // Gespeicherte Fehler tragen ggf. den Klassennamen als Praefix ("Error: ...").
  const text = raw.replace(/^[A-Za-z]*Error: /, "");
  if (KNOWN_TEXTS.has(text)) return text;
  if (raw.includes(SEND_UNCLEAR_NOTE)) return SEND_UNCLEAR_NOTE;
  return GENERIC_ACTION_ERROR;
}

/**
 * Schritte eines Laufs: das Feld error jedes Schritts wird auf einen festen Hinweis reduziert; bei fehlgeschlagenen
 * Schritten entfaellt der Freitext note (kann Rohtext enthalten).
 */
export function publicSteps(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps;
  return steps.map((s: unknown) => {
    if (typeof s !== "object" || s === null || !("error" in s)) return s;
    const { error, ...withNote } = s as { error?: unknown } & Record<string, unknown>;
    const rest: Record<string, unknown> = { ...withNote };
    if (withNote.status === "FAILED") delete rest.note;
    return typeof error === "string" ? { ...rest, error: publicErrorText(error) } : rest;
  });
}
