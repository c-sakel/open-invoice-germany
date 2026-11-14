/** Fachfehler der Abo-Verwaltung (Anlegen, Bearbeiten, Lauf). */
export class RecurringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurringError";
  }
}
