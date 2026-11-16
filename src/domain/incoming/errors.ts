/**
 * Fehler der Eingangsrechnungs-Annahme. Meldungen enthalten nie Dateiinhalt.
 */
import { XmlSafetyError } from "@/lib/xml/safe";

export type IncomingFormatCode =
  | "EMPTY"
  | "TOO_LARGE"
  | "ZIP_NOT_SUPPORTED"
  | "UNSUPPORTED_TYPE"
  | "NOT_UTF8"
  | "UNSUPPORTED_ENCODING"
  | "FORBIDDEN_MARKUP"
  | "TOO_DEEP"
  | "TOO_MANY_ELEMENTS"
  | "MALFORMED"
  | "NOT_AN_INVOICE";

/** Die Datei kann nicht als Rechnung gelesen werden; 422. */
export class IncomingFormatError extends Error {
  readonly status = 422;
  constructor(
    message: string,
    readonly code: IncomingFormatCode,
  ) {
    super(message);
    this.name = "IncomingFormatError";
  }
}

/** Dieselbe Datei wurde bereits angenommen; 409 ALREADY_RECEIVED. */
export class IncomingDuplicateError extends Error {
  readonly status = 409;
  constructor(readonly existingId: string) {
    super("Diese Datei wurde bereits angenommen.");
    this.name = "IncomingDuplicateError";
  }
}

/** Die PDF-Pruefung ist ausgelastet; die Annahme wird nicht als "ohne Rechnungsdaten" abgelegt, sondern spaeter wiederholt (503). */
export class IncomingBusyError extends Error {
  readonly status = 503;
  constructor() {
    super("Die Annahme ist gerade ausgelastet. Bitte in einigen Sekunden erneut versuchen.");
    this.name = "IncomingBusyError";
  }
}

/** Uebersetzt Fehler der Sicherheitspruefung in Annahmefehler. */
export function toFormatError(e: unknown): unknown {
  if (!(e instanceof XmlSafetyError)) return e;
  if (e.code === "TOO_DEEP") return new IncomingFormatError("Die XML-Struktur ist zu tief verschachtelt.", "TOO_DEEP");
  if (e.code === "FORBIDDEN_MARKUP") {
    return new IncomingFormatError(
      `Die Datei enthaelt nicht erlaubtes Markup (${e.detail ?? "DTD/Entities"}).`,
      "FORBIDDEN_MARKUP",
    );
  }
  return new IncomingFormatError("Die Datei ist kein gueltiges XML.", "MALFORMED");
}

export type IncomingWorkflowCode =
  | "INVALID_TRANSITION"
  | "REASON_REQUIRED"
  | "PAID_DATE_INVALID"
  | "NOTE_TOO_LONG"
  | "STATUS_CONFLICT"
  | "STATUS_LOCKED"
  | "MANUAL_NOT_ALLOWED"
  | "CONTACT_NOT_FOUND"
  | "ALREADY_ASSIGNED"
  | "CONTACT_INCOMPLETE";

const WORKFLOW_STATUS: Record<IncomingWorkflowCode, number> = {
  INVALID_TRANSITION: 409,
  REASON_REQUIRED: 400,
  PAID_DATE_INVALID: 400,
  NOTE_TOO_LONG: 400,
  STATUS_CONFLICT: 409,
  STATUS_LOCKED: 409,
  MANUAL_NOT_ALLOWED: 422,
  CONTACT_NOT_FOUND: 422,
  ALREADY_ASSIGNED: 409,
  CONTACT_INCOMPLETE: 422,
};

/** Fehler im Bearbeitungsablauf (Status, Zuordnung, Kopfdaten von Hand); `status` ist der HTTP-Status. */
export class IncomingWorkflowError extends Error {
  readonly status: number;
  constructor(
    message: string,
    readonly code: IncomingWorkflowCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IncomingWorkflowError";
    this.status = WORKFLOW_STATUS[code];
  }
}
