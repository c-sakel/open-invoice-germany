/**
 * Reine Hilfen der Kontoabruf-Oberfläche: feste Texte je Code, Zustände, Warnungen und kleine Formatierer.
 * Kein React und kein Netz. Texte der Bank erscheinen nie (außer der Challenge-Text der Freigabe, nur als Text);
 * angezeigt werden nur diese festen Texte.
 */

export const FINTS_ORG_URL = "https://www.fints.org";

export const PRODUCT_ID_NOTICE =
  "FinTS-Zugang nur für registrierte Produkte. Die Registrierung ist bei der Deutschen Kreditwirtschaft kostenlos (fints.org, Hersteller, Produktregistrierung, Kategorie Web-Server); die Bearbeitung dauert etwa 10 bis 15 Werktage. Die Nummer gehört zu Ihrer Installation und wird nicht weitergegeben.";

export const PRODUCT_ID_STORED_NOTICE = "Produkt-ID hinterlegt. Aus Sicherheitsgründen wird sie nicht angezeigt; ein neuer Wert ersetzt den alten.";

export const READ_ONLY_NOTICE =
  "Dieses Programm sendet nur Abfragen (Konten und Umsätze), keine Überweisungen oder Lastschriften. Abgerufene Umsätze erscheinen im Bankabgleich; gebucht wird nur nach Ihrer Bestätigung.";

export const PIN_MODE_PER_FETCH = "PIN je Abruf (Standard): Die PIN wird nur für den laufenden Abruf verwendet und nie gespeichert. Ein automatischer täglicher Abruf ist damit nicht möglich.";

export const PIN_STORE_CONFIRM_TEXT =
  "Die PIN erlaubt mit einer TAN auch Zahlungen in Ihrem Online-Banking; dieses Programm sendet nur Abfragen. Ich möchte die PIN verschlüsselt speichern, damit der tägliche Abruf möglich ist.";

export const SCA_RENEW_HINT = "Die Bank darf die Freigabe auch früher verlangen; spätestens bis zu diesem Tag muss sie erneuert werden.";

export const SECRET_FIELD_HINT = "Wird nie angezeigt und nie zurückgegeben.";

export const URL_HINT = "Steht auf den Hilfeseiten Ihrer Bank und beginnt mit https://.";

export const NO_CAMT_TEXT = "Bank bietet keinen CAMT-Abruf";

export const ARCHIVE_CONFIRM_TEXT = "Bankzugang entfernen? Er wird archiviert, die gespeicherte PIN gelöscht und der automatische Abruf beendet. Bereits importierte Umsätze bleiben erhalten.";

export const OPTICAL_CHIPTAN_HINT = "Dieses Verfahren erfordert eine optische Übertragung (Flickercode) und wird nicht unterstützt. Bitte ein anderes Verfahren wählen.";

export const GENERIC_BANK_FETCH_ERROR = "Die Aktion konnte nicht ausgeführt werden.";

export const FORBIDDEN_TEXT = "Anfrage nicht zulässig.";

export const NOT_FOUND_TEXT = "Nicht gefunden.";

export const SESSION_LOST_TEXT = "Freigabe abgebrochen, bitte erneut abrufen.";

const ERROR_TEXTS: Record<string, string> = {
  // Fachliche Fehler (BankFetchError)
  PRODUCT_ID_MISSING: "Die Produkt-ID für den Kontoabruf ist noch nicht hinterlegt.",
  PIN_REQUIRED: "Bitte die PIN eingeben.",
  PIN_PREVIOUSLY_REJECTED: "Diese PIN wurde von der Bank abgelehnt. Bitte zuerst die Zugangsdaten bei der Bank prüfen und die Wiederholung ausdrücklich bestätigen.",
  ACCESS_LOCKED: "Die Bank hat den Zugang gesperrt. Bitte den Zugang zuerst bei der Bank entsperren und das ausdrücklich bestätigen.",
  SECRET_UNREADABLE: "Die gespeicherte PIN ist nicht lesbar. Bitte neu eingeben.",
  TEST_REQUIRED: "Der automatische Abruf kann erst nach einem erfolgreichen manuellen Abruf mit den aktuellen Zugangsdaten eingeschaltet werden.",
  PIN_NOT_STORED: "Für den automatischen Abruf muss die PIN gespeichert sein.",
  NO_ACCOUNT_SELECTED: "Für den automatischen Abruf muss mindestens ein Konto mit Umsatzabruf ausgewählt sein.",
  LIMIT_CONNECTIONS: "Es sind höchstens drei Bankzugänge je Firma möglich.",
  LIMIT_ACCOUNTS: "Es können höchstens zehn Konten je Firma ausgewählt werden.",
  ACCOUNT_NOT_SUPPORTED: "Für dieses Konto bietet die Bank keinen Umsatzabruf im CAMT-Format an.",
  BUSY: "Für diesen Bankzugang läuft gerade ein Vorgang.",
  SCA_TIMEOUT: "Die Freigabe wurde nicht rechtzeitig erteilt.",
  TAN_FORMAT: "Die TAN hat ein ungültiges Format.",
  NOT_SET_UP: "Der Bankzugang muss zuerst eingerichtet werden (Anmeldung und Kontenabruf).",
  RATE_LIMITED: "Der Abruf wurde gerade erst gestartet. Bitte eine Minute warten.",
  NOT_ELIGIBLE: "Für diesen Bankzugang ist kein automatischer Abruf möglich.",
  // Codes des Bankprotokolls (FintsError) und der Abrufprotokolle
  NETWORK_BLOCKED: "Der Netzzugriff ist in dieser Umgebung gesperrt.",
  URL_INVALID: "Die Adresse des Bankservers ist ungültig. Sie muss mit https:// beginnen.",
  HOST_NOT_ALLOWED: "Der Server ist nicht freigegeben.",
  HOST_BLOCKED: "Der Server liegt in einem gesperrten Adressbereich.",
  DNS_FAILED: "Der Servername konnte nicht aufgelöst werden.",
  CONNECT_FAILED: "Keine Verbindung zum Server.",
  TLS_FAILED: "Die verschlüsselte Verbindung konnte nicht aufgebaut werden.",
  TIMEOUT: "Zeitüberschreitung bei der Verbindung.",
  HTTP_STATUS: "Der Server hat die Anfrage nicht angenommen.",
  TOO_LARGE: "Die Antwort der Bank ist zu groß.",
  PROTOCOL_ERROR: "Unerwartete Antwort der Bank.",
  DECODE_FAILED: "Die Antwort der Bank konnte nicht gelesen werden.",
  SEGMENT_NOT_ALLOWED: "Es werden nur lesende Abfragen gesendet.",
  PIN_REJECTED: "Die Bank hat die Anmeldung abgelehnt. Automatischer Abruf ist aus. Bitte PIN prüfen — nach mehreren Fehlversuchen sperrt die Bank den Zugang.",
  AUTH_UNCLEAR: "Die Anmeldung ist fehlgeschlagen, der Grund ist unklar. Automatischer Abruf ist aus. Bitte die Zugangsdaten prüfen, bevor es erneut versucht wird.",
  BANK_ERROR: "Die Bank hat die Abfrage abgelehnt.",
  NO_CAMT: "Die Bank liefert keine Umsätze im CAMT-Format.",
  CAMT_UNSAFE: "Ein Umsatzdokument der Bank ist nicht zulässig.",
  ACCOUNT_MISMATCH: "Ein Umsatzdokument gehört nicht zum abgefragten Konto.",
  SCA_REJECTED: "Die Freigabe wurde abgelehnt.",
  SCA_REQUIRED: "Die Bank verlangt eine Freigabe. Bitte den Abruf manuell starten und freigeben.",
  SCA_CANCELLED: "Die Freigabe wurde abgebrochen.",
  IMPORT_CONFLICT: "Die Umsätze konnten nicht übernommen werden, weil sich der Bestand gleichzeitig geändert hat. Bitte erneut abrufen.",
  OK: "Erfolgreich",
};

/** Fester Text je Code; unbekannte Codes erscheinen nie im Wortlaut. */
export function bankFetchErrorText(code: string | null | undefined): string {
  if (code == null) return GENERIC_BANK_FETCH_ERROR;
  return ERROR_TEXTS[code] ?? GENERIC_BANK_FETCH_ERROR;
}

const STATE_TEXTS: Record<string, string> = {
  NEW: "Noch nicht abgerufen",
  READY: "Bereit",
  SCA_REQUIRED: "Freigabe nötig",
  PIN_REJECTED: "Anmeldung abgelehnt",
  AUTH_UNCLEAR: "Anmeldung unklar",
  ERROR: "Fehler beim letzten Abruf",
};

export function connectionStateText(state: string): string {
  return STATE_TEXTS[state] ?? "Unbekannt";
}

export type Tone = "ok" | "warn" | "neutral";

export function connectionStateTone(state: string): Tone {
  if (state === "READY") return "ok";
  if (state === "NEW") return "neutral";
  return "warn";
}

/** Anmeldung nach Ablehnung oder bei unklarem Fehler: erneutes Senden nur nach ausdrücklicher Bestätigung. */
export function needsUnlockConfirm(state: string, lastErrorCode: string | null): "NONE" | "PIN" | "BANK" {
  if (state !== "PIN_REJECTED" && state !== "AUTH_UNCLEAR") return "NONE";
  return lastErrorCode === "ACCESS_LOCKED" ? "BANK" : "PIN";
}

export const UNLOCK_CONFIRM_TEXT = "Ich habe die Zugangsdaten bei der Bank geprüft und möchte die Anmeldung erneut versuchen.";
export const BANK_UNLOCK_CONFIRM_TEXT = "Ich habe den gesperrten Zugang bei der Bank entsperren lassen.";

/** Verfahren, die eine optische Übertragung (Flickercode) brauchen, werden nicht angeboten. */
export function isOpticalChipTan(name: string): boolean {
  return /flicker|optisch|comfort|\busb\b/i.test(name);
}

export interface TanMethodOption {
  id: number;
  name: string;
  decoupled: boolean;
  media: string[];
}

/** Bevorzugt Freigabe in der Banking-App, dann übrige Verfahren; Reihenfolge der Bank sonst stabil nach Nummer. */
export function sortTanMethods(methods: readonly TanMethodOption[]): TanMethodOption[] {
  return [...methods].sort((a, b) => Number(b.decoupled) - Number(a.decoupled) || a.id - b.id);
}

/** Bildquelle nur für erlaubte Rastergrafiken als Daten-URL. */
export function isSafeImageDataUrl(src: string | null): src is string {
  return src !== null && /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/]+=*$/.test(src);
}

const TZ = "Europe/Berlin";

export function formatDateTime(iso: string | null): string {
  if (iso === null) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat("de-DE", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(d);
}

export function formatDay(iso: string | null): string {
  if (iso === null) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  return new Intl.DateTimeFormat("de-DE", { timeZone: TZ, dateStyle: "medium" }).format(d);
}

export interface ConnectionWarningInput {
  state: string;
  lastErrorCode: string | null;
  autoEnabled: boolean;
  hasPin: boolean;
}

/** Feste Warnungen je Zugang (kein Banktext). */
export function connectionWarnings(c: ConnectionWarningInput): string[] {
  const out: string[] = [];
  if (c.state === "PIN_REJECTED" || c.state === "AUTH_UNCLEAR") {
    out.push(bankFetchErrorText(c.lastErrorCode === "ACCESS_LOCKED" ? "ACCESS_LOCKED" : c.state));
  } else if (c.state === "SCA_REQUIRED") {
    out.push(bankFetchErrorText("SCA_REQUIRED"));
  } else if (c.state === "ERROR" && c.lastErrorCode) {
    out.push(bankFetchErrorText(c.lastErrorCode));
  }
  return out;
}

export interface RunLike {
  from: string | null;
  to: string | null;
  gapBefore: string | null;
}

/** Lücke im Abrufzeitraum: gewünschter Beginn liegt vor dem tatsächlich abgerufenen Zeitraum (automatisch höchstens 89 Tage). */
export function gapWarning(run: RunLike): string | null {
  if (run.gapBefore === null || run.from === null) return null;
  return `Der Zeitraum wurde gekürzt: Umsätze vor dem ${formatDay(run.from)} (gewünscht ab ${formatDay(run.gapBefore)}) fehlen. Bitte den Zeitraum bei Bedarf manuell abrufen oder eine Datei importieren.`;
}

export function originLabel(origin: string): string {
  return origin === "FINTS" ? "Kontoabruf" : "Datei-Upload";
}

export function maskedConnectionUser(userId: string): string {
  const chars = Array.from(userId);
  if (chars.length <= 4) return "***";
  return `${chars.slice(0, 2).join("")}***${chars.slice(-2).join("")}`;
}
