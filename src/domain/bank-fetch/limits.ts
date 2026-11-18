/**
 * Grenzen fuer den Kontoabruf. Eine Stelle, damit Transport, Adapter, Abruf und Oberflaeche dieselben Werte nutzen.
 */
import { MAX_CAMT_BYTES, MAX_CAMT_TOTAL_BYTES } from "@/domain/bank/errors";

const KB = 1024;
const MB = 1024 * KB;

/** Antwort einer Bank-Nachricht (nach Base64-Dekodierung); die Base64-Laenge darf 4/3 davon betragen. */
export const FINTS_MAX_RESPONSE_BYTES = 16 * MB;
/** Segmentenden (unmaskierte Hochkommas) je Nachricht. */
export const FINTS_MAX_SEGMENTS = 20_000;
/** Nachrichten und Bytes je Dialog (deckelt die Fortsetzungsschleife der Bank). */
export const FINTS_MAX_MESSAGES_PER_DIALOG = 100;
export const FINTS_MAX_BYTES_PER_DIALOG = 64 * MB;

/** Zeitgrenzen (ms). */
export const FINTS_DNS_TIMEOUT_MS = 5_000;
export const FINTS_CONNECT_TIMEOUT_MS = 10_000;
export const FINTS_REQUEST_TIMEOUT_MS = 60_000;
/** Abmelden (HKEND) ist best effort und darf nie lange aufhalten. */
export const FINTS_END_TIMEOUT_MS = 10_000;
/** Gesamtdauer eines Dialogs im Hintergrund-Job bzw. Wartezeit auf eine Freigabe in der Oberflaeche. */
export const FINTS_DIALOG_TIMEOUT_MS = 3 * 60_000;
export const FINTS_SCA_TIMEOUT_MS = 5 * 60_000;
/** Probe-Dekodierung im Worker. */
export const FINTS_PROBE_TIMEOUT_MS = 2_000;
export const FINTS_PROBE_HEAP_MB = 256;
/** Obergrenzen der Probe: auch eine grosse, rechtmaessige Antwort darf sie nie ueberschreiten. */
export const FINTS_PROBE_MAX_TIMEOUT_MS = 20_000;
export const FINTS_PROBE_MAX_HEAP_MB = 768;

/** Statusabfragen einer Freigabe in der App: hoechstens min(Bank, 60), Wartezeit mindestens 2 s. */
export const FINTS_MAX_STATUS_POLLS = 60;
export const FINTS_MIN_WAIT_MS = 2_000;

/** CAMT-Dokumente: je Konto-Abruf, je Dokument, Summe (Dokument und Summe gelten auch fuer den Import, eine Definition). */
export const FINTS_MAX_DOCUMENTS = 400;
export const FINTS_MAX_DOCUMENT_BYTES = MAX_CAMT_BYTES;
export const FINTS_MAX_DOCUMENT_TOTAL_BYTES = MAX_CAMT_TOTAL_BYTES;

/** BPD/UPD (serialisiert), Challenge-Text, TAN-Bild. */
export const FINTS_MAX_BANKING_INFO_BYTES = 256 * KB;
export const FINTS_MAX_CHALLENGE_CHARS = 500;
export const FINTS_MAX_TAN_IMAGE_BYTES = 256 * KB;

/** Bankzugaenge und ausgewaehlte Konten je Firma. */
export const MAX_BANK_CONNECTIONS = 3;
export const MAX_FETCH_ACCOUNTS = 10;

/** Abruf: Sperre je Bankzugang, manuelle Abrufe, voruebergehende Fehler. */
export const FETCH_LEASE_MS = 10 * 60_000;
export const MANUAL_FETCH_MIN_INTERVAL_MS = 60_000;
export const TRANSIENT_RETRY_MIN_MS = 2 * 60 * 60_000;
export const MAX_TRANSIENT_ATTEMPTS_PER_DAY = 3;

/** Zeitraum: automatisch hoechstens 89 Tage (ohne Freigabe), manuell mit Freigabe 365, Ueberlappung, erster Abruf. */
export const FETCH_MAX_DAYS_AUTO = 89;
export const FETCH_MAX_DAYS_MANUAL = 365;
export const FETCH_OVERLAP_DAYS = 7;
export const FETCH_FIRST_DAYS_DEFAULT = 30;
