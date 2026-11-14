/**
 * Fehler des Bankabgleichs. Meldungen enthalten nie Dateiinhalt (kein Verwendungszweck, keine IBAN).
 */
export type CamtErrorCode =
  | "TOO_LARGE"
  | "NOT_UTF8"
  | "FORBIDDEN_MARKUP"
  | "TOO_DEEP"
  | "ZIP_NOT_SUPPORTED"
  | "NOT_CAMT"
  | "UNSUPPORTED_VERSION"
  | "NO_IBAN"
  | "BAD_AMOUNT"
  | "BAD_DATE"
  | "TOO_MANY_ENTRIES"
  | "MALFORMED";

export class CamtFormatError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly code: CamtErrorCode,
  ) {
    super(message);
    this.name = "CamtFormatError";
  }
}

export const MAX_CAMT_BYTES = 10 * 1024 * 1024;
export const MAX_CAMT_ENTRIES = 50_000;
export const MAX_STORED_TX = 20_000;
