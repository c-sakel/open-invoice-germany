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
