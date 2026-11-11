export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Optionale Erfolgsmeldung (z. B. Ergebnis eines Kursabrufs). */
  message?: string;
}
