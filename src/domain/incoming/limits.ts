/**
 * Grenzen fuer die Annahme von Eingangsrechnungen. Eine Stelle, damit alle Kanaele (Oberflaeche,
 * REST, MCP, Postfach) dieselben Werte nutzen.
 */
const MB = 1024 * 1024;

/** Groesse der angenommenen Datei (vor und nach dem Lesen). */
export const MAX_INCOMING_BYTES = 15 * MB;
/** Gesamtgroesse eines REST-Aufrufs (Base64 plus Rahmen). */
export const MAX_INCOMING_REST_BODY_BYTES = 21 * MB;
/** Dekodierte Dateigroesse beim MCP-Aufruf. */
export const MAX_INCOMING_MCP_BYTES = 2 * MB;
/** Dateien je Sammel-Upload. */
export const MAX_INCOMING_BATCH_FILES = 20;
/** Annahmen je Minute und Firma. */
export const INCOMING_RECEIVE_PER_MINUTE = 30;

/** PDF: Anlagen, dekomprimierte Groesse je Anlage und Laufzeit der Pruefung. */
export const MAX_PDF_ATTACHMENTS = 20;
export const MAX_PDF_ATTACHMENT_BYTES = 15 * MB;
export const PDF_EXTRACT_TIMEOUT_MS = 10_000;
/** PDF: Summe aller entpackten Bytes, geprueft Vorkommen von /EmbeddedFile und wartende Pruefungen. */
export const MAX_PDF_TOTAL_BYTES = 30 * MB;
export const MAX_PDF_CANDIDATES = 200;
export const MAX_PDF_QUEUE = 5;
/** Schematron-Pruefung: Laufzeit. */
export const VALIDATE_TIMEOUT_MS = 60_000;

/** Positionen, die je Beleg ausgelesen werden. */
export const MAX_INCOMING_LINES = 5_000;
/** Befunde je Pruefung und Zeichen je Befund. */
export const MAX_FINDINGS = 500;
export const MAX_FINDING_TEXT = 500;

/** Anzeigetexte und Notizen aus der Datei. */
export const MAX_DISPLAY_TEXT = 1_000;
export const MAX_NOTE_TEXT = 4_000;
/** Listen im Modell (Notizen, Anlagen, Steuerzeilen, Zahlungsarten, Vorrechnungen). */
export const MAX_LIST_ITEMS = 200;

/** Betraege aus fremden Dateien: groesster zulaessiger Betrag in Cent (Spaltenbreite Int32). */
export const MAX_AMOUNT_CENTS = 2_147_483_647;

/** Positionen je Antwort des MCP-Werkzeugs (die Antwort geht durch den Modellkontext). */
export const MAX_MCP_LINES = 200;
/** Manuelle Pruefungen je Minute und Firma (jede Pruefung startet einen eigenen Prozess). */
export const INCOMING_VALIDATE_PER_MINUTE = 10;
