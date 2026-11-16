/**
 * Grenzen fuer den Postfach-Abruf. Eine Stelle, damit Adapter, Worker und Abruf-Job dieselben Werte nutzen.
 */
const MB = 1024 * 1024;

/** Mails je Lauf und Firma. */
export const MAX_MAILS_PER_RUN = 20;
/** Groesse einer Mail (Serverangabe vor dem Laden, Zaehler beim Laden). */
export const MAX_MAIL_BYTES = 25 * MB;
/** Anlagen je Mail, die ausgewertet werden. */
export const MAX_MAIL_ATTACHMENTS = 10;
/** Groesse je Anlage. */
export const MAX_MAIL_ATTACHMENT_BYTES = 15 * MB;
/** MIME-Teile je Mail, Verschachtelungstiefe, Kopfbereich. */
export const MAX_MAIL_PARTS = 100;
export const MAX_MAIL_NESTING = 5;
export const MAX_MAIL_HEADER_BYTES = 64 * 1024;
/** Betreff (Zeichen). */
export const MAX_SUBJECT_CHARS = 200;
/** Gelesene UIDs je Suche. */
export const MAX_SEARCH_UIDS = 5000;

/** Zeitgrenzen (ms). */
export const MAIL_CONNECT_TIMEOUT_MS = 20_000;
export const MAIL_COMMAND_TIMEOUT_MS = 60_000;
export const MAIL_RUN_TIMEOUT_MS = 5 * 60_000;
export const MAIL_WORKER_TIMEOUT_MS = 15_000;
export const MAIL_WORKER_HEAP_MB = 256;
