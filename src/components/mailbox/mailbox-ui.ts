/**
 * Reine Hilfen der Postfach-Oberfläche: feste Texte je Code, Reiter und Vorschau-Beschriftung.
 * Kein React und kein Netz. Servertexte erscheinen nie; angezeigt werden nur diese Texte.
 */
import { formatIncomingMoney } from "@/components/incoming/incoming-ui";

export const MAILBOX_NOTICE =
  "Nur ein eigens für Rechnungen eingerichtetes Postfach verwenden. Mails werden nie gelöscht oder verschoben, nur als gelesen markiert. Anmeldung mit Passwort bzw. App-Passwort; Postfächer mit reiner OAuth-Anmeldung werden nicht unterstützt.";

export const SENDER_FILTER_WARNING =
  "Ein Absenderfilter wird dringend empfohlen. Der Absender einer Mail ist fälschbar: Der Filter schränkt nur die Menge ein und prüft nicht, ob eine Mail wirklich von dieser Domain stammt (keine Authentisierung). Jede Datei wird deshalb erst nach Ihrer Sichtung übernommen.";

export const STAGING_NOTICE =
  "Erst mit Übernehmen wird die Datei Teil der Eingangsrechnungen und unveränderlich abgelegt. Verworfene Dateien werden nach 30 Tagen aus der Zwischenablage entfernt; die Mail bleibt im Postfach.";

export const PASSWORD_AGAIN_NOTICE = "Passwort neu eingeben: Nach einer Änderung von Server, Port, Sicherheit oder Benutzer wird das gespeicherte Passwort aus Sicherheitsgründen entfernt.";

const ERROR_TEXTS: Record<string, string> = {
  HOST_BLOCKED: "Der Server liegt in einem gesperrten Adressbereich.",
  HOST_NOT_ALLOWED: "Der Server ist nicht freigegeben.",
  DNS_FAILED: "Der Servername konnte nicht aufgelöst werden.",
  PORT_NOT_ALLOWED: "Es sind nur Port 993 (TLS) und Port 143 (STARTTLS) erlaubt.",
  CONNECT_FAILED: "Keine Verbindung zum Server.",
  TLS_FAILED: "Die verschlüsselte Verbindung konnte nicht aufgebaut werden.",
  STARTTLS_MISSING: "Der Server bietet keine Verschlüsselung (STARTTLS) an.",
  AUTH_FAILED: "Die Anmeldung wurde abgelehnt.",
  OAUTH_REQUIRED: "Dieses Postfach erlaubt keine Anmeldung mit Passwort. Bitte ein App-Passwort oder ein eigenes Postfach für Rechnungen verwenden.",
  FOLDER_NOT_FOUND: "Der Ordner wurde nicht gefunden.",
  TIMEOUT: "Zeitüberschreitung bei der Verbindung.",
  TOO_LARGE: "Die Nachricht ist zu groß.",
  PROTOCOL_ERROR: "Unerwartete Antwort des Servers.",
  NETWORK_BLOCKED: "Der Netzzugriff ist in dieser Umgebung gesperrt.",
  NOT_CONFIGURED: "Server, Benutzer und Passwort sind noch nicht vollständig eingetragen.",
  COOLDOWN: "Bitte kurz warten und dann erneut versuchen.",
  SECRET_UNREADABLE: "Das gespeicherte Passwort ist nicht lesbar. Bitte neu eingeben.",
  DISABLED: "Das Postfach ist ausgeschaltet. Bitte zuerst einschalten.",
  MARK_SEEN_FAILED: "Der Server erlaubt das Markieren als gelesen nicht (Ordner nur lesbar?). Bereits abgerufene Mails werden nicht doppelt aufgenommen.",
  QUOTA_FULL: "Der Abruf ist pausiert: Die Sichtung ist voll. Bitte Belege übernehmen oder verwerfen.",
  TEST_REQUIRED: "Das Postfach kann erst nach einem erfolgreichen Verbindungstest eingeschaltet werden.",
  FETCH_SINCE_INVALID: "Das Datum darf nicht in der Zukunft und höchstens 365 Tage zurück liegen.",
  NOT_INBOX: "Die Anlage wartet nicht mehr auf eine Entscheidung.",
  CONFLICT: "Die Anlage wurde gleichzeitig anders entschieden.",
  PURGED: "Die verworfene Anlage ist nicht mehr wiederherstellbar.",
  STAGING_MISSING: "Die Datei in der Zwischenablage fehlt oder wurde verändert.",
  ALREADY_RECEIVED: "Diese Datei wurde bereits als Eingangsrechnung angenommen.",
  NOT_FOUND: "Anlage nicht gefunden.",
  BUSY: "Die Prüfung ist gerade ausgelastet. Bitte in einigen Sekunden erneut versuchen.",
  ERROR: "Die Aktion konnte nicht ausgeführt werden.",
};

/** Gleiche Grenze wie `MAX_ACCEPT_BATCH` (Schema); hier getrennt, damit der Browser-Code keine Servermodule lädt. */
export const UI_MAX_ACCEPT_BATCH = 20;

export const GENERIC_MAILBOX_ERROR = "Die Aktion konnte nicht ausgeführt werden.";

/** Fester Text je Code; unbekannte Codes zeigen nie Rohtext. */
export function mailboxErrorText(code: string | null | undefined): string {
  if (!code) return GENERIC_MAILBOX_ERROR;
  return ERROR_TEXTS[code] ?? GENERIC_MAILBOX_ERROR;
}

export const SKIP_TEXTS: Record<string, string> = {
  TYPE: "Dateityp nicht unterstützt (nur XML und PDF)",
  TOO_LARGE: "Anlage zu groß",
  TOO_MANY: "zu viele Anlagen in der Mail",
  NESTED: "zu tief verschachtelt",
  MAIL_TOO_LARGE: "Mail zu groß (über 25 MB), nicht gelesen; sie liegt als gelesen im Postfach",
  MAIL_UNREADABLE: "Mail konnte nicht gelesen werden; sie liegt als gelesen im Postfach",
};

export function skipText(reason: string | null): string {
  return reason ? (SKIP_TEXTS[reason] ?? "übersprungen") : "übersprungen";
}

export const INBOX_TABS = ["INBOX", "ACCEPTED", "DISCARDED", "SKIPPED"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const INBOX_TAB_LABELS: Record<InboxTab, string> = {
  INBOX: "Zu sichten",
  ACCEPTED: "Übernommen",
  DISCARDED: "Verworfen",
  SKIPPED: "Übersprungen",
};

/** Doppelte Anlagen erscheinen unter "Übersprungen". */
export function tabStatuses(tab: InboxTab): ("INBOX" | "ACCEPTED" | "DISCARDED" | "DUPLICATE" | "SKIPPED")[] {
  return tab === "SKIPPED" ? ["SKIPPED", "DUPLICATE"] : [tab];
}

export function parseInboxTab(raw: string | undefined): InboxTab {
  return INBOX_TABS.find((t) => t === raw) ?? "INBOX";
}

export interface PreviewView {
  kind: string | null;
  isEInvoice: boolean;
  number: string | null;
  supplierName: string | null;
  grossCents: number | null;
  currency: string | null;
}

/** Liest die gespeicherte Vorschau defensiv (kommt aus einer Datei, nie vertrauen). */
export function toPreviewView(raw: unknown): PreviewView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, 200) : null);
  return {
    kind: str(o.kind),
    isEInvoice: o.isEInvoice === true,
    number: str(o.number),
    supplierName: str(o.supplierName),
    grossCents: typeof o.grossCents === "number" && Number.isSafeInteger(o.grossCents) ? o.grossCents : null,
    currency: str(o.currency),
  };
}

export function previewKindLabel(p: PreviewView): string {
  if (p.kind === "OTHER") return "Sonstige Rechnung (PDF/Bild)";
  return p.isEInvoice ? "E-Rechnung" : "Keine vollständige E-Rechnung";
}

export const PREVIEW_CAVEAT = "aus der Datei, ungeprüft";

export function previewAmount(p: PreviewView): string {
  return formatIncomingMoney(p.grossCents, p.currency);
}

/** Herkunftszeile der Eingangsrechnung bei Kanal MAILBOX. */
export function mailOriginText(src: { internalDate: string | null; fetchedAt: string | null; senderDomain: string | null }, fmt: (iso: string | null) => string): string {
  return `per E-Mail empfangen am ${fmt(src.internalDate)}, abgerufen am ${fmt(src.fetchedAt)}, Absender-Domain ${src.senderDomain ?? "–"} (Angabe der Mail, nicht geprüft)`;
}

export const CHANNEL_LABELS: Record<string, string> = {
  UPLOAD: "Upload",
  API: "REST-Schnittstelle",
  MCP: "MCP",
  MAILBOX: "Postfach",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}
