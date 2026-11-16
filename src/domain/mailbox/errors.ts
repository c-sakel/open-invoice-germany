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

export type InboundMailErrorCode = "NOT_INBOX" | "CONFLICT" | "PURGED" | "STAGING_MISSING" | "ALREADY_RECEIVED" | "QUOTA_FULL";

const INBOUND_MESSAGES: Record<InboundMailErrorCode, string> = {
  NOT_INBOX: "Die Anlage wartet nicht mehr auf eine Entscheidung.",
  CONFLICT: "Die Anlage wurde gleichzeitig anders entschieden.",
  PURGED: "Die verworfene Anlage ist nicht mehr wiederherstellbar.",
  STAGING_MISSING: "Die Datei in der Zwischenablage fehlt oder wurde veraendert.",
  ALREADY_RECEIVED: "Diese Datei wurde bereits als Eingangsrechnung angenommen.",
  QUOTA_FULL: "Die Sichtung ist voll. Bitte zuerst Belege uebernehmen oder verwerfen.",
};

/** Entscheidung ueber eine Postfach-Anlage nicht moeglich; 409. */
export class InboundMailError extends Error {
  readonly status = 409;
  constructor(
    readonly code: InboundMailErrorCode,
    readonly details?: { incomingInvoiceId?: string },
  ) {
    super(INBOUND_MESSAGES[code]);
    this.name = "InboundMailError";
  }
}
