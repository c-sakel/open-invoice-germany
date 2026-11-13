import { EXPORT_ROW_LIMIT } from "./limits";

/** Zu viele Zeilen fuer einen CSV-Export (Phase 18b). Eigene Datei, damit Tests die Grenze senken koennen. */
export class ExportTooLargeError extends Error {
  readonly status = 413;
  constructor(limit: number = EXPORT_ROW_LIMIT, hint = "") {
    super(`Mehr als ${limit.toLocaleString("de-DE")} Zeilen — bitte Filter einschränken.${hint ? ` ${hint}` : ""}`);
    this.name = "ExportTooLargeError";
  }
}
