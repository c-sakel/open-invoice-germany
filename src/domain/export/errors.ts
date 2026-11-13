/** Zu viele Zeilen fuer einen CSV-Export (Phase 18b). Eigene Datei, damit Tests die Grenze senken koennen. */
export class ExportTooLargeError extends Error {
  readonly status = 413;
  constructor() {
    super("Mehr als 20.000 Zeilen — bitte Filter einschränken.");
    this.name = "ExportTooLargeError";
  }
}
