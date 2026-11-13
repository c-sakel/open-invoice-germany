/**
 * Prozesslokale Serialisierung je Schluessel (Phase 18c): Aufrufe mit gleichem Schluessel laufen
 * strikt nacheinander, verschiedene Schluessel parallel. Ein Fehler blockiert Nachfolger nicht
 * und wird nur an den eigenen Aufrufer gereicht.
 *
 * Schuetzt nur innerhalb eines Prozesses; bei Mehrinstanz-Betrieb faengt die
 * P2002-Wiederholung (src/lib/chain-retry.ts bzw. bulk-cancel) Kettenkonflikte ab.
 */
const tails = new Map<string, Promise<unknown>>();

export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}
