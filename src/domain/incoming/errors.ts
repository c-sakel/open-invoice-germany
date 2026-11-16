/**
 * Fehler der Eingangsrechnungs-Annahme. Meldungen enthalten nie Dateiinhalt.
 */
import { XmlSafetyError } from "@/lib/xml/safe";

export type IncomingFormatCode =
  | "EMPTY"
  | "TOO_LARGE"
  | "ZIP_NOT_SUPPORTED"
  | "UNSUPPORTED_TYPE"
  | "NOT_UTF8"
  | "UNSUPPORTED_ENCODING"
  | "FORBIDDEN_MARKUP"
  | "TOO_DEEP"
  | "MALFORMED"
  | "NOT_AN_INVOICE";

/** Die Datei kann nicht als Rechnung gelesen werden; 422. */
export class IncomingFormatError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly code: IncomingFormatCode,
  ) {
    super(message);
    this.name = "IncomingFormatError";
  }
}

/** Dieselbe Datei wurde bereits angenommen; 409 ALREADY_RECEIVED. */
export class IncomingDuplicateError extends Error {
  readonly status = 409;
  constructor(readonly existingId: string) {
    super("Diese Datei wurde bereits angenommen.");
    this.name = "IncomingDuplicateError";
  }
}

/** Uebersetzt Fehler der Sicherheitspruefung in Annahmefehler. */
export function toFormatError(e: unknown): unknown {
  if (!(e instanceof XmlSafetyError)) return e;
  if (e.code === "TOO_DEEP") return new IncomingFormatError("Die XML-Struktur ist zu tief verschachtelt.", "TOO_DEEP");
  if (e.code === "FORBIDDEN_MARKUP") {
    return new IncomingFormatError(
      `Die Datei enthaelt nicht erlaubtes Markup (${e.detail ?? "DTD/Entities"}).`,
      "FORBIDDEN_MARKUP",
    );
  }
  return new IncomingFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
}
