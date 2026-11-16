export type MailboxSettingsErrorCode = "TEST_REQUIRED" | "NOT_CONFIGURED" | "FETCH_SINCE_INVALID";

const SETTINGS_MESSAGES: Record<MailboxSettingsErrorCode, string> = {
  TEST_REQUIRED: "Das Postfach kann erst nach einem erfolgreichen Verbindungstest eingeschaltet werden.",
  NOT_CONFIGURED: "Server, Benutzer und Passwort sind noch nicht vollstaendig eingetragen.",
  FETCH_SINCE_INVALID: "Das Datum darf nicht in der Zukunft und hoechstens 365 Tage zurueck liegen.",
};

export class MailboxSettingsError extends Error {
  constructor(readonly code: MailboxSettingsErrorCode) {
    super(SETTINGS_MESSAGES[code]);
    this.name = "MailboxSettingsError";
  }
}

/** Die Datei in der Zwischenablage fehlt oder weicht vom gespeicherten Hash ab. */
export class StagingTamperedError extends Error {
  constructor() {
    super("Die Datei in der Zwischenablage fehlt oder wurde veraendert.");
    this.name = "StagingTamperedError";
  }
}
