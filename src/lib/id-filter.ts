/**
 * Id-Mengen als eigener Filterteil (Phase 17c, Task 4): Listen koennen auf eine Menge von
 * Beleg-Ids eingeschraenkt sein (Tag-Zuordnungen, Abrechnungsstand). Eine einzelne
 * `id IN (...)`-Abfrage stoesst bei grossen Mengen an die Bind-Parameter-Grenze von SQLite,
 * deshalb gilt: bis `ID_CHUNK_SIZE` Ids eine Abfrage wie bisher, darueber je Block eine
 * Abfrage mit Summen-/Merge-Logik. Der Aufrufer baut jede Block-Abfrage aus demselben
 * Basis-`where` (inkl. `orgId`) und haengt nur die `IdCond` an — nie `id IN` allein.
 *
 * Reine Funktionen ohne Datenbankzugriff; die Abfragen kommen als Callbacks.
 */

/** Block-Groesse. Bewusst unter 1.000: die Abfrage-Engine begrenzt Bind-Parameter je Abfrage
 *  (SQLite: 999) und kann Abfragen mit Negationsfiltern (`not`) nicht selbst aufteilen — die
 *  uebrigen Filterwerte einer Abfrage kommen zu den Ids hinzu. */
export const ID_CHUNK_SIZE = 900;

/** `null` = kein Id-Filter, `[]` = leere Menge (Ergebnis immer leer, ohne Abfrage). */
export type IdSet = readonly string[] | null;
export type IdCond = { id: { in: string[] } } | null;

/** Dedupliziert (Reihenfolge stabil) und teilt in Bloecke zu `size` Ids. */
export function chunkIds(ids: readonly string[], size: number = ID_CHUNK_SIZE): string[][] {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

/** Schnittmenge zweier Id-Mengen; `null` ist neutral. */
export function intersectIdSets(a: IdSet, b: IdSet): IdSet {
  if (a === null) return b;
  if (b === null) return a;
  const inB = new Set(b);
  return [...new Set(a)].filter((id) => inB.has(id));
}

/** Summe ueber Bloecke; Ids werden vorher dedupliziert, damit nichts doppelt zaehlt. */
export async function countByIdSet(ids: IdSet, run: (c: IdCond) => Promise<number>, size: number = ID_CHUNK_SIZE): Promise<number> {
  if (ids === null) return run(null);
  let total = 0;
  for (const chunk of chunkIds(ids, size)) total += await run({ id: { in: chunk } });
  return total;
}

/** Konkatenation der Block-Ergebnisse (Aufrufer fuehren Summen/Gruppen selbst zusammen). */
export async function collectByIdSet<T>(ids: IdSet, run: (c: IdCond) => Promise<T[]>, size: number = ID_CHUNK_SIZE): Promise<T[]> {
  if (ids === null) return run(null);
  const out: T[] = [];
  for (const chunk of chunkIds(ids, size)) out.push(...(await run({ id: { in: chunk } })));
  return out;
}

export interface SortSpec {
  key: string;
  dir: "asc" | "desc";
  nulls: "first" | "last";
}

/** Totale Ordnung: Sortfeld (Nullwerte gemaess `nulls`, unabhaengig von `dir`), dann `id` aufsteigend. */
export function compareBySort<R extends { id: string }>(
  sort: SortSpec,
  get: (r: R) => string | number | Date | null,
): (a: R, b: R) => number {
  const norm = (v: string | number | Date | null): string | number | null => (v instanceof Date ? v.getTime() : v);
  return (a, b) => {
    const x = norm(get(a));
    const y = norm(get(b));
    if (x === null || y === null) {
      if (x !== y) {
        const nullFirst = sort.nulls === "first" ? -1 : 1;
        return x === null ? nullFirst : -nullFirst;
      }
    } else if (x !== y) {
      const c = x < y ? -1 : 1;
      return sort.dir === "asc" ? c : -c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

export interface PageByIdSetParams<Full extends { id: string }, Key extends { id: string }> {
  offset: number;
  limit: number;
  compare: (a: Key, b: Key) => number;
  /** Bisheriger Weg (skip/take), wenn `ids` null oder hoechstens `size` Ids. */
  single: (c: IdCond) => Promise<Full[]>;
  /** Je Block ALLE Schluessel: nur `id` + Sortfeld, ohne `orderBy`/`take` (die Reihenfolge bestimmt allein `compare`). */
  keys: (c: IdCond) => Promise<Key[]>;
  /** Volle Zeilen der Seite; das Ergebnis wird in der Reihenfolge von `pageIds` zurueckgegeben. */
  byIds: (pageIds: string[]) => Promise<Full[]>;
}

/**
 * Eine Seite ueber eine Id-Menge. Bei grossen Mengen holt jeder Block ALLE Schluessel
 * (id + Sortfeld, ohne DB-Sortierung: Collation und JS-Vergleich koennen bei Text abweichen,
 * ein DB-seitiges top-N je Block wuerde dann Treffer an der Blockgrenze verlieren). Die
 * Reihenfolge bestimmt allein die totale Ordnung `compare`; erst danach werden die vollen
 * Zeilen der Seite geladen.
 */
export async function pageByIdSet<Full extends { id: string }, Key extends { id: string }>(
  ids: IdSet,
  p: PageByIdSetParams<Full, Key>,
  size: number = ID_CHUNK_SIZE,
): Promise<Full[]> {
  if (ids === null) return p.single(null);
  const chunks = chunkIds(ids, size);
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return p.single({ id: { in: chunks[0] } });

  const all: Key[] = [];
  for (const chunk of chunks) all.push(...(await p.keys({ id: { in: chunk } })));
  all.sort(p.compare);
  const pageIds = all.slice(p.offset, p.offset + p.limit).map((k) => k.id);
  if (pageIds.length === 0) return [];
  const rows = await p.byIds(pageIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return pageIds.flatMap((id) => {
    const r = byId.get(id);
    return r ? [r] : [];
  });
}

export interface OrderedIdsParams<Key extends { id: string }> {
  limit: number;
  compare: (a: Key, b: Key) => number;
  /** `take` gilt nur ohne Merge (null bzw. ein Block, `orderBy` wie die Liste); je Block im Merge: alle Schluessel. */
  keys: (c: IdCond, take?: number) => Promise<Key[]>;
}

/**
 * Die ersten `limit` Ids in Listenreihenfolge (Vor/Zurueck-Navigation, Phase 17c, Task 6):
 * ohne Id-Menge bzw. bei einem Block eine Abfrage (DB-Reihenfolge, `take: limit`), sonst je
 * Block alle Schluessel, Reihenfolge allein per `compare`, Abschnitt `0..limit`.
 */
export async function orderedIdsByIdSet<Key extends { id: string }>(
  ids: IdSet,
  p: OrderedIdsParams<Key>,
  size: number = ID_CHUNK_SIZE,
): Promise<string[]> {
  if (ids === null) return (await p.keys(null, p.limit)).map((k) => k.id);
  const chunks = chunkIds(ids, size);
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return (await p.keys({ id: { in: chunks[0] } }, p.limit)).map((k) => k.id);
  const all: Key[] = [];
  for (const chunk of chunks) all.push(...(await p.keys({ id: { in: chunk } })));
  all.sort(p.compare);
  return all.slice(0, p.limit).map((k) => k.id);
}
