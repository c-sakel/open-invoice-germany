/** Fachfehler der Abo-Verwaltung (Anlegen, Bearbeiten, Lauf). */
export class RecurringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurringError";
  }
}

/**
 * Phase 18f: Verbrauchsabo ist noch nicht faellig (Periode endet erst am Stichtag, abgerechnet wird ab dem
 * Berliner Folgetag). Unterklasse von RecurringError, damit bestehende Fehlerbehandlung (REST/MCP 4xx) greift.
 */
export class RecurringNotDueError extends RecurringError {
  constructor(message: string) {
    super(message);
    this.name = "RecurringNotDueError";
  }
}
