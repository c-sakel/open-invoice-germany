export type BankFetchErrorCode =
  | "PRODUCT_ID_MISSING"
  | "PIN_REQUIRED"
  | "PIN_PREVIOUSLY_REJECTED"
  | "ACCESS_LOCKED"
  | "SECRET_UNREADABLE"
  | "TEST_REQUIRED"
  | "PIN_NOT_STORED"
  | "NO_ACCOUNT_SELECTED"
  | "LIMIT_CONNECTIONS"
  | "LIMIT_ACCOUNTS"
  | "ACCOUNT_NOT_SUPPORTED"
  | "BUSY"
  | "SCA_TIMEOUT"
  | "TAN_FORMAT"
  | "NOT_SET_UP"
  | "RATE_LIMITED"
  | "NOT_ELIGIBLE";

const MESSAGES: Record<BankFetchErrorCode, string> = {
  PRODUCT_ID_MISSING: "Die Produkt-ID fuer den Kontoabruf ist noch nicht hinterlegt.",
  PIN_REQUIRED: "Bitte die PIN eingeben.",
  PIN_PREVIOUSLY_REJECTED: "Diese PIN wurde von der Bank abgelehnt. Bitte zuerst die Zugangsdaten bei der Bank pruefen und die Wiederholung ausdruecklich bestaetigen.",
  ACCESS_LOCKED: "Die Bank hat den Zugang gesperrt. Bitte den Zugang zuerst bei der Bank entsperren und das ausdruecklich bestaetigen.",
  SECRET_UNREADABLE: "Die gespeicherte PIN ist nicht lesbar. Bitte neu eingeben.",
  TEST_REQUIRED: "Der automatische Abruf kann erst nach einem erfolgreichen manuellen Abruf mit den aktuellen Zugangsdaten eingeschaltet werden.",
  PIN_NOT_STORED: "Fuer den automatischen Abruf muss die PIN gespeichert sein.",
  NO_ACCOUNT_SELECTED: "Fuer den automatischen Abruf muss mindestens ein Konto mit Umsatzabruf ausgewaehlt sein.",
  LIMIT_CONNECTIONS: "Es sind hoechstens drei Bankzugaenge je Firma moeglich.",
  LIMIT_ACCOUNTS: "Es koennen hoechstens zehn Konten je Firma ausgewaehlt werden.",
  ACCOUNT_NOT_SUPPORTED: "Fuer dieses Konto bietet die Bank keinen Umsatzabruf im CAMT-Format an.",
  BUSY: "Fuer diesen Bankzugang laeuft gerade ein Vorgang.",
  SCA_TIMEOUT: "Die Freigabe wurde nicht rechtzeitig erteilt.",
  TAN_FORMAT: "Die TAN hat ein ungueltiges Format.",
  NOT_SET_UP: "Der Bankzugang muss zuerst eingerichtet werden (Anmeldung und Kontenabruf).",
  RATE_LIMITED: "Der Abruf wurde gerade erst gestartet. Bitte eine Minute warten.",
  NOT_ELIGIBLE: "Fuer diesen Bankzugang ist kein automatischer Abruf moeglich.",
};

/** Fachlicher Fehler des Kontoabrufs mit festem Code und festem Text (nie Banktexte, nie Zugangsdaten); 409. */
export class BankFetchError extends Error {
  readonly status = 409;
  constructor(readonly code: BankFetchErrorCode) {
    super(MESSAGES[code]);
    this.name = "BankFetchError";
  }
}
