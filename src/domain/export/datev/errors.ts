/** Fachfehler der DATEV-Einstellungen, Kontenzuordnung und Debitorennummern (feste Codes, deutsche Meldungen). */
export type DatevErrorCode =
  | "VALIDATION"
  | "ACCOUNT_OUT_OF_RANGE"
  | "DEBTOR_RANGE_EXHAUSTED"
  | "DEBTOR_LOCKED"
  | "DEBTOR_DUPLICATE"
  | "SETTINGS_INCOMPLETE"
  | "NOT_FOUND";

export class DatevError extends Error {
  constructor(
    public readonly code: DatevErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatevError";
  }
}

export type DatevExportErrorCode =
  | "NOT_CONFIRMED"
  | "INVALID_PERIOD"
  | "ALREADY_EXPORTED"
  | "NOTHING_TO_EXPORT"
  | "MISSING_MAPPING"
  | "MISSING_TRANSIT"
  | "MISSING_BANK"
  | "MISSING_DEBTOR"
  | "AMOUNT_OUT_OF_RANGE"
  | "ACCOUNT_TOO_LONG"
  | "NOT_FOUND"
  | "FILE_TAMPERED";

/** Fachfehler des Exportlaufs. `status`: 409 (Wiederholung/nichts zu tun), 404, 500 (Datei veraendert), sonst 422. */
export class DatevExportError extends Error {
  readonly status: 404 | 409 | 422 | 500;
  constructor(
    public readonly code: DatevExportErrorCode,
    message: string,
    public readonly details: { months?: string[]; issues?: { code: string; message: string; key?: string; documents?: string[] }[] } = {},
  ) {
    super(message);
    this.name = "DatevExportError";
    this.status = code === "NOT_FOUND" ? 404 : code === "ALREADY_EXPORTED" || code === "NOTHING_TO_EXPORT" ? 409 : code === "FILE_TAMPERED" ? 500 : 422;
  }
}
