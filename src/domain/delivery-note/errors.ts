/** Fehlerklassen des Lieferschein-Moduls (aus create.ts ausgelagert; create.ts re-exportiert sie). */
export class DeliveryNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryNoteError";
  }
}

/** Nit (Fix-Welle): Eingabevalidierung (z. B. BILLING-Adresse als Lieferadresse) — Route
 *  mappt dies auf 400, waehrend die generische DeliveryNoteError (nicht gefunden o. ae.)
 *  bei 409 bleibt. */
export class DeliveryNoteValidationError extends DeliveryNoteError {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryNoteValidationError";
  }
}

/** Bearbeiten nur im Entwurf (DRAFT); alles andere -> 409. */
export class DeliveryNoteNotDraftError extends DeliveryNoteError {
  constructor(message = "Nur ein Lieferschein-Entwurf kann bearbeitet werden.") {
    super(message);
    this.name = "DeliveryNoteNotDraftError";
  }
}
