/**
 * Sperre fuer die serielle Pruefung. Die Kette haengt an `globalThis` (Symbol.for), nicht am Modul:
 * Next.js bundelt Routen und Hintergrundlauf getrennt, jedes Bundle hat sonst eine eigene Kette und
 * es liefen mehrere Java-Prozesse (je bis ~590 MB) gleichzeitig.
 */
const TAIL_KEY = Symbol.for("oig.incomingValidation.tail");
const WAITING_KEY = Symbol.for("oig.incomingValidation.waiting");

type WithTail = { [TAIL_KEY]?: Promise<unknown>; [WAITING_KEY]?: number };

/** Anzahl der Pruefungen, die in der Kette laufen oder warten. */
export function pendingExclusive(): number {
  return (globalThis as WithTail)[WAITING_KEY] ?? 0;
}

/** Eine Pruefung nach der anderen im ganzen Prozess. */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as WithTail;
  const prev = g[TAIL_KEY] ?? Promise.resolve();
  g[WAITING_KEY] = (g[WAITING_KEY] ?? 0) + 1;
  const next = prev.then(fn, fn).finally(() => {
    g[WAITING_KEY] = Math.max(0, (g[WAITING_KEY] ?? 1) - 1);
  });
  g[TAIL_KEY] = next.catch(() => undefined);
  return next;
}
