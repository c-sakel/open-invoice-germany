/** Fehler beim Festschreiben (eigene Datei, damit src/domain/fx/snapshot.ts ohne Importzyklus erben kann). */
export class FinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalizeError";
  }
}
