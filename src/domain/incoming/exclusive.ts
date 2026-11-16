/**
 * Sperre fuer die serielle Pruefung. Die Kette haengt an `globalThis` (Symbol.for), nicht am Modul:
 * Next.js bundelt Routen und Hintergrundlauf getrennt, jedes Bundle hat sonst eine eigene Kette und
 * es liefen mehrere Java-Prozesse (je bis ~590 MB) gleichzeitig.
 */
const TAIL_KEY = Symbol.for("oig.incomingValidation.tail");

type WithTail = { [TAIL_KEY]?: Promise<unknown> };

/** Eine Pruefung nach der anderen im ganzen Prozess. */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as WithTail;
  const prev = g[TAIL_KEY] ?? Promise.resolve();
  const next = prev.then(fn, fn);
  g[TAIL_KEY] = next.catch(() => undefined);
  return next;
}
