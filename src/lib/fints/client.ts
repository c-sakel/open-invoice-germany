/**
 * Schnittstelle zum Bankzugang per FinTS. Der Abruf kennt nur diese Typen; Netz und Protokoll liegen im Adapter.
 * Fehler tragen nur einen festen Code und hoechstens vierstellige Rueckmeldecodes, nie Text oder Zugangsdaten.
 */
export type FintsErrorCode =
  | "NETWORK_BLOCKED"
  | "URL_INVALID"
  | "HOST_NOT_ALLOWED"
  | "HOST_BLOCKED"
  | "DNS_FAILED"
  | "CONNECT_FAILED"
  | "TLS_FAILED"
  | "TIMEOUT"
  | "HTTP_STATUS"
  | "TOO_LARGE"
  | "PROTOCOL_ERROR"
  | "DECODE_FAILED"
  | "SEGMENT_NOT_ALLOWED"
  | "PIN_REJECTED"
  | "AUTH_UNCLEAR"
  | "ACCESS_LOCKED"
  | "BANK_ERROR"
  | "NO_CAMT"
  | "CAMT_UNSAFE"
  | "ACCOUNT_MISMATCH"
  | "SCA_TIMEOUT"
  | "SCA_REJECTED"
  | "TAN_FORMAT";

const MESSAGES: Record<FintsErrorCode, string> = {
  NETWORK_BLOCKED: "Der Netzzugriff ist in dieser Umgebung gesperrt.",
  URL_INVALID: "Die Adresse des Bankservers ist ungueltig.",
  HOST_NOT_ALLOWED: "Der Server ist nicht freigegeben.",
  HOST_BLOCKED: "Der Server liegt in einem gesperrten Adressbereich.",
  DNS_FAILED: "Der Servername konnte nicht aufgeloest werden.",
  CONNECT_FAILED: "Keine Verbindung zum Server.",
  TLS_FAILED: "Die verschluesselte Verbindung konnte nicht aufgebaut werden.",
  TIMEOUT: "Zeitueberschreitung bei der Verbindung.",
  HTTP_STATUS: "Der Server hat die Anfrage nicht angenommen.",
  TOO_LARGE: "Die Antwort der Bank ist zu gross.",
  PROTOCOL_ERROR: "Unerwartete Antwort der Bank.",
  DECODE_FAILED: "Die Antwort der Bank konnte nicht gelesen werden.",
  SEGMENT_NOT_ALLOWED: "Es werden nur lesende Abfragen gesendet.",
  PIN_REJECTED: "Die Bank hat die Anmeldung abgelehnt.",
  AUTH_UNCLEAR: "Die Anmeldung ist fehlgeschlagen, der Grund ist unklar.",
  ACCESS_LOCKED: "Die Bank hat den Zugang gesperrt.",
  BANK_ERROR: "Die Bank hat die Abfrage abgelehnt.",
  NO_CAMT: "Die Bank liefert keine Umsaetze im CAMT-Format.",
  CAMT_UNSAFE: "Ein Umsatzdokument der Bank ist nicht zulaessig.",
  ACCOUNT_MISMATCH: "Ein Umsatzdokument gehoert nicht zum abgefragten Konto.",
  SCA_TIMEOUT: "Die Freigabe wurde nicht rechtzeitig erteilt.",
  SCA_REJECTED: "Die Freigabe wurde abgelehnt.",
  TAN_FORMAT: "Die TAN hat ein ungueltiges Format.",
};

export class FintsError extends Error {
  readonly bankCodes: string[];

  constructor(
    readonly code: FintsErrorCode,
    bankCodes: readonly string[] = [],
  ) {
    super(MESSAGES[code]);
    this.name = "FintsError";
    this.bankCodes = bankCodes.filter((c) => /^\d{4}$/.test(c)).slice(0, 10);
  }
}

export interface FintsAccess {
  productId: string;
  productVersion: string;
  url: string;
  bankCode: string;
  userId: string;
  customerId: string | null;
  pin: string;
  tanMethodId: number | null;
  tanMediaName: string | null;
  /** JSON aus einer frueheren Sitzung (BPD/UPD/Systemkennung). */
  bankingInfo: string | null;
}

export interface ScaChallenge {
  decoupled: boolean;
  /** Anzeigetext der Bank (<= 500 Zeichen, ohne Steuerzeichen), nur fluechtig anzeigen, nie speichern. */
  text: string;
  image: { mime: "image/png" | "image/jpeg"; bytes: Uint8Array } | null;
  waitFirstMs: number;
  waitNextMs: number;
  maxPolls: number;
}

export type FintsStep<T> =
  | { kind: "done"; value: T; scaUsed: boolean; bankCodes: string[] }
  | { kind: "sca"; challenge: ScaChallenge };

export interface FintsAccountInfo {
  iban: string;
  accountNumber: string | null;
  subAccount: string | null;
  currency: string | null;
  productName: string | null;
  camtSupported: boolean;
}

export interface FintsSyncResult {
  tanMethods: { id: number; name: string; decoupled: boolean; media: string[]; mediaRequired: boolean }[];
  accounts: FintsAccountInfo[];
  camtFormats: string[];
  maxHistoryDays: number | null;
}

export interface FintsCamtResult {
  documents: Uint8Array[];
  bytes: number;
  /** Tatsaechlich abgerufener Beginn (Tag YYYY-MM-DD); spaeter als angefragt, wenn die Bank den Rueckblick begrenzt. */
  from?: string;
}

export interface FintsSession {
  synchronize(): Promise<FintsStep<FintsSyncResult>>;
  /** Tage YYYY-MM-DD. */
  fetchCamt(iban: string, from: string, to: string): Promise<FintsStep<FintsCamtResult>>;
  /** Setzt den offenen Schritt fort (gleicher Ergebnistyp wie der Ausloeser). Ohne TAN nur bei Freigabe in der App. */
  continueSca(tan?: string): Promise<FintsStep<FintsSyncResult | FintsCamtResult>>;
  /** Aktuelle BPD/UPD/Systemkennung ohne Banktexte, <= 256 KB, sonst TOO_LARGE. */
  bankingInfo(): string | null;
  /** Beendet den Dialog (HKEND, best effort), wirft nie. */
  close(): Promise<void>;
}

export interface FintsClient {
  open(access: FintsAccess, opts?: { allowSca?: boolean }): FintsSession;
}
