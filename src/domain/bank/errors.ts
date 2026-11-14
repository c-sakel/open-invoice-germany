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

/** Der Umsatz wurde parallel veraendert oder ist bereits (anders) zugeordnet; 409. */
export class BankConflictError extends Error {
  readonly status = 409;
  constructor(message = "Der Umsatz wurde zwischenzeitlich veraendert. Bitte neu laden und erneut pruefen.") {
    super(message);
    this.name = "BankConflictError";
  }
}

/** Zuordnung nicht zulaessig (Status, Waehrung, Summe, Richtung); 422. */
export class BankAllocationError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "BankAllocationError";
  }
}
