/**
 * Re-Entrancy-Guard fuers Auto-Speichern (Phase 13b, Fix-Welle nach Task 6 — Review-
 * Finding: zwei schnelle Trigger VOR dem ersten `draft.id` — z. B. der Speichern-Knopf
 * und `AttachmentsBlock.ensureDocId` (Datei-Upload) fast gleichzeitig, oder zwei
 * parallele Uploads — duerfen NICHT zwei POSTs und damit zwei Entwuerfe erzeugen.
 *
 * `createSaveGuard()` liefert `run(fn)`: waehrend ein vorheriger `run`-Aufruf noch
 * aussteht, bekommt ein weiterer Aufruf DASSELBE Promise zurueck (wartet mit), OHNE
 * `fn` ein zweites Mal auszufuehren — dessen eigene Argumente/Variante (z. B.
 * `opts.navigate`) spielen dabei keine Rolle, massgeblich ist der zuerst gestartete
 * Aufruf. Sobald das Promise abgeschlossen ist (Erfolg oder Fehler), startet der
 * naechste `run`-Aufruf wieder frisch (neuer POST moeglich, z. B. fuer den naechsten
 * Speichervorgang nach einer erfolgreichen Aenderung).
 *
 * In `DocumentEditor.tsx` verwendet: ein `useRef(createSaveGuard<string | null>())`
 * pro Editor-Instanz, `save()` ruft `guard.run(() => performSave(opts))`. Der Guard
 * selbst kennt weder React noch `fetch` — reiner Zustandsautomat, deshalb ohne DOM/RTL
 * in `test/unit/save-guard.test.ts` testbar (kein jsdom im Projekt, siehe
 * vitest.config.ts `environment: "node"`).
 */
export interface SaveGuard<T> {
  run(fn: () => Promise<T>): Promise<T>;
}

export function createSaveGuard<T>(): SaveGuard<T> {
  let inFlight: Promise<T> | null = null;
  return {
    run(fn: () => Promise<T>): Promise<T> {
      if (inFlight) return inFlight;
      const p = fn().finally(() => {
        inFlight = null;
      });
      inFlight = p;
      return p;
    },
  };
}
