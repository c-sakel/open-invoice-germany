/**
 * Schnittstelle zum Postfach. Der Abruf-Job kennt nur diese Typen; Netz und Protokoll liegen im Adapter.
 * Fehler tragen nur einen festen Code, nie Text vom Server.
 */
export type MailboxErrorCode =
  | "HOST_BLOCKED"
  | "HOST_NOT_ALLOWED"
  | "DNS_FAILED"
  | "PORT_NOT_ALLOWED"
  | "CONNECT_FAILED"
  | "TLS_FAILED"
  | "STARTTLS_MISSING"
  | "AUTH_FAILED"
  | "OAUTH_REQUIRED"
  | "FOLDER_NOT_FOUND"
  | "TIMEOUT"
  | "TOO_LARGE"
  | "PROTOCOL_ERROR"
  | "NETWORK_BLOCKED";

const MESSAGES: Record<MailboxErrorCode, string> = {
  HOST_BLOCKED: "Der Server liegt in einem gesperrten Adressbereich.",
  HOST_NOT_ALLOWED: "Der Server ist nicht freigegeben.",
  DNS_FAILED: "Der Servername konnte nicht aufgeloest werden.",
  PORT_NOT_ALLOWED: "Es sind nur Port 993 (TLS) und Port 143 (STARTTLS) erlaubt.",
  CONNECT_FAILED: "Keine Verbindung zum Server.",
  TLS_FAILED: "Die verschluesselte Verbindung konnte nicht aufgebaut werden.",
  STARTTLS_MISSING: "Der Server bietet keine Verschluesselung (STARTTLS) an.",
  AUTH_FAILED: "Die Anmeldung wurde abgelehnt.",
  OAUTH_REQUIRED: "Dieses Postfach erlaubt keine Anmeldung mit Passwort.",
  FOLDER_NOT_FOUND: "Der Ordner wurde nicht gefunden.",
  TIMEOUT: "Zeitueberschreitung bei der Verbindung.",
  TOO_LARGE: "Die Nachricht ist zu gross.",
  PROTOCOL_ERROR: "Unerwartete Antwort des Servers.",
  NETWORK_BLOCKED: "Der Netzzugriff ist in dieser Umgebung gesperrt.",
};

export class MailboxError extends Error {
  constructor(readonly code: MailboxErrorCode) {
    super(MESSAGES[code]);
    this.name = "MailboxError";
  }
}

export interface MailboxAccount {
  host: string;
  port: 993 | 143;
  security: "TLS" | "STARTTLS";
  username: string;
  password: string;
  folder: string;
}

export interface MailboxSession {
  uidValidity: string;
  /** UIDs ungelesener Nachrichten, aufsteigend, hoechstens 5.000 gelesen. */
  searchUnseen(since: Date | null): Promise<string[]>;
  meta(uid: string): Promise<{ size: number; internalDate: Date | null } | null>;
  /** Wirft TOO_LARGE bei Ueberschreitung von maxBytes. */
  fetchRaw(uid: string, maxBytes: number): Promise<Uint8Array>;
  markSeen(uid: string): Promise<void>;
  countUnseen(): Promise<number>;
  close(): Promise<void>;
}

export interface MailboxClient {
  open(account: MailboxAccount): Promise<MailboxSession>;
}
