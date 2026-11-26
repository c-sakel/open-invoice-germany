/**
 * Prozessweite Liste der Jobs, die in DIESEM Prozess noch laufen (auch nach einer Zeitueberschreitung).
 * Solange ein Job hier steht, startet weder der Runner noch ein Einzelabruf (`withJobLock`) ihn erneut
 * und raeumt seine Sperre nicht ab: ein abgebrochenes Warten beendet den Job nicht, ein zweiter Lauf
 * koennte z. B. beim Autoversand doppelt senden. `globalThis`, damit HMR die Liste nicht verliert.
 */
declare global {
  var __oigInflightJobs: Map<string, Promise<unknown>> | undefined;
}

export function inflightJobs(): Map<string, Promise<unknown>> {
  globalThis.__oigInflightJobs ??= new Map();
  return globalThis.__oigInflightJobs;
}
