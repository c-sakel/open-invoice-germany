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

/** Zeitraum (inklusive Grenzen) als Kalendertage, fuer Hinweise zum Wechsel der Abrechnungsart. */
export interface TimingChangePeriod {
  start: Date;
  end: Date;
}

export interface TimingChangeDetails {
  /** Zuletzt abgerechneter Zeitraum (null, wenn keine Rechnung mit Zeitraum ermittelbar). */
  lastBilled: TimingChangePeriod | null;
  /** Zeitraum der naechsten Rechnung nach dem Wechsel. */
  nextPeriod: TimingChangePeriod;
  /** Tage ohne Abrechnung zwischen letztem und naechstem Zeitraum (>= 0). */
  gapDays: number;
  /** Tage, die doppelt abgerechnet wuerden (>= 0). */
  overlapDays: number;
}

/**
 * Wechsel der Abrechnungsart eines Abos mit bereits erzeugten Rechnungen ohne Bestaetigung:
 * der Betreiber soll Luecke/Ueberlappung vor dem Speichern sehen (REST/UI 409 mit `details`).
 */
export class RecurringTimingChangeError extends RecurringError {
  readonly details: TimingChangeDetails;
  constructor(details: TimingChangeDetails) {
    const parts: string[] = [];
    if (details.gapDays > 0) parts.push(`${details.gapDays} Tag(e) blieben unberechnet`);
    if (details.overlapDays > 0) parts.push(`${details.overlapDays} Tag(e) würden doppelt berechnet`);
    super(
      `Der Wechsel der Abrechnungsart ändert den Zeitraum der nächsten Rechnung${parts.length > 0 ? `: ${parts.join(", ")}` : ""}. Zum Bestätigen acknowledgeTimingChange setzen.`,
    );
    this.name = "RecurringTimingChangeError";
    this.details = details;
  }
}
