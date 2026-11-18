export type BankFetchErrorCode =
  | "PRODUCT_ID_MISSING"
  | "PIN_REQUIRED"
  | "PIN_PREVIOUSLY_REJECTED"
  | "SECRET_UNREADABLE"
  | "TEST_REQUIRED"
  | "PIN_NOT_STORED"
  | "NO_ACCOUNT_SELECTED"
  | "LIMIT_CONNECTIONS"
  | "LIMIT_ACCOUNTS"
  | "ACCOUNT_NOT_SUPPORTED"
  | "BUSY"
  | "SCA_TIMEOUT"
  | "TAN_FORMAT";

const MESSAGES: Record<BankFetchErrorCode, string> = {
  PRODUCT_ID_MISSING: "Die Produkt-ID fuer den Kontoabruf ist noch nicht hinterlegt.",
  PIN_REQUIRED: "Bitte die PIN eingeben.",
  PIN_PREVIOUSLY_REJECTED: "Diese PIN wurde von der Bank abgelehnt. Bitte zuerst die Zugangsdaten bei der Bank pruefen und die Wiederholung ausdruecklich bestaetigen.",
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
};

/** Fachlicher Fehler des Kontoabrufs mit festem Code und festem Text (nie Banktexte, nie Zugangsdaten); 409. */
export class BankFetchError extends Error {
  readonly status = 409;
  constructor(readonly code: BankFetchErrorCode) {
    super(MESSAGES[code]);
    this.name = "BankFetchError";
  }
}
