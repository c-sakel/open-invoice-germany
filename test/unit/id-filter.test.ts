import { describe, it, expect, vi } from "vitest";
import { chunkIds, intersectIdSets, countByIdSet, collectByIdSet, compareBySort, orderedIdsByIdSet, pageByIdSet, type IdCond, type SortSpec } from "@/lib/id-filter";

interface Row {
  id: string;
  v: number | null;
}

function dataset(n: number): Row[] {
  // Gleiche Sortwerte und Nullwerte bewusst eingestreut.
  return Array.from({ length: n }, (_, i) => ({ id: `id${String(n - i).padStart(2, "0")}`, v: i % 3 === 0 ? null : i % 2 }));
}

describe("chunkIds / intersectIdSets", () => {
  it("dedupliziert und teilt in Bloecke", () => {
    expect(chunkIds(["a", "b", "a", "c", "d"], 2)).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("Schnittmenge, null ist neutral", () => {
    expect(intersectIdSets(null, ["x"])).toEqual(["x"]);
    expect(intersectIdSets(["a", "b"], ["b", "c"])).toEqual(["b"]);
    expect(intersectIdSets([], null)).toEqual([]);
  });
});

describe("countByIdSet / collectByIdSet", () => {
  it("null: ein Aufruf mit null", async () => {
    const run = vi.fn(async () => 7);
    expect(await countByIdSet(null, run)).toBe(7);
    expect(run).toHaveBeenCalledWith(null);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("leere Menge: 0 ohne Aufruf", async () => {
    const run = vi.fn(async () => 7);
    expect(await countByIdSet([], run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    const collect = vi.fn(async () => [1]);
    expect(await collectByIdSet([], collect)).toEqual([]);
    expect(collect).not.toHaveBeenCalled();
  });
  it("5 Ids bei size 2: drei Aufrufe, Summe, Duplikate zaehlen einmal", async () => {
    const run = vi.fn(async (c: IdCond) => (c ? c.id.in.length : 0));
    expect(await countByIdSet(["a", "b", "c", "d", "e", "e", "a"], run, 2)).toBe(5);
    expect(run).toHaveBeenCalledTimes(3);
    expect(await collectByIdSet(["a", "b", "c"], async (c) => (c ? c.id.in : []), 2)).toEqual(["a", "b", "c"]);
  });
});

describe("pageByIdSet", () => {
  const all = dataset(7);
  const sorts: SortSpec[] = [
    { key: "v", dir: "asc", nulls: "last" },
    { key: "v", dir: "desc", nulls: "last" },
  ];
  for (const sort of sorts) {
    it(`entspricht dem Referenzergebnis (${sort.dir}, nulls last)`, async () => {
      const compare = compareBySort<Row>(sort, (r) => r.v);
      const reference = [...all].sort(compare);
      const ids = all.map((r) => r.id);
      for (let offset = 0; offset <= 6; offset++) {
        for (let limit = 1; limit <= 4; limit++) {
          const byIds = vi.fn(async (pageIds: string[]) => all.filter((r) => pageIds.includes(r.id)));
          const page = await pageByIdSet<Row, Row>(
            ids,
            {
              offset,
              limit,
              compare,
              single: async (c) => [...all].filter((r) => !c || c.id.in.includes(r.id)).sort(compare).slice(offset, offset + limit),
              keys: async (c) => all.filter((r) => c?.id.in.includes(r.id)),
              byIds,
            },
            3,
          );
          expect(page.map((r) => r.id)).toEqual(reference.slice(offset, offset + limit).map((r) => r.id));
          expect(byIds.mock.calls.length).toBeLessThanOrEqual(1);
          if (byIds.mock.calls.length === 1) expect(byIds.mock.calls[0][0].length).toBeLessThanOrEqual(limit);
        }
      }
    });
  }

  it("gleiche Sortwerte: id aufsteigend; nulls last bei asc und desc", () => {
    const rows: Row[] = [
      { id: "b", v: 1 },
      { id: "a", v: 1 },
      { id: "n", v: null },
      { id: "c", v: 0 },
    ];
    const asc = [...rows].sort(compareBySort<Row>({ key: "v", dir: "asc", nulls: "last" }, (r) => r.v)).map((r) => r.id);
    const desc = [...rows].sort(compareBySort<Row>({ key: "v", dir: "desc", nulls: "last" }, (r) => r.v)).map((r) => r.id);
    expect(asc).toEqual(["c", "a", "b", "n"]);
    expect(desc).toEqual(["a", "b", "c", "n"]);
  });

  it("leere Menge: leer ohne Abfrage; null: bisheriger Weg", async () => {
    const single = vi.fn(async () => [{ id: "x" }]);
    const keys = vi.fn(async () => []);
    const base = { offset: 0, limit: 5, compare: () => 0, single, keys, byIds: async () => [] };
    expect(await pageByIdSet([], base)).toEqual([]);
    expect(single).not.toHaveBeenCalled();
    expect(await pageByIdSet(null, base)).toEqual([{ id: "x" }]);
    expect(keys).not.toHaveBeenCalled();
  });
});

describe("Textsortierung ueber mehrere Bloecke (Collation != Code-Units)", () => {
  interface NumRow {
    id: string;
    number: string;
  }
  // Locale-Reihenfolge (Gross-/Kleinschreibung, Bindestrich) weicht von Code-Units ab.
  const dbCollate = (a: NumRow, b: NumRow) => a.number.localeCompare(b.number, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : 1);
  const rows: NumRow[] = Array.from({ length: 1850 }, (_, i) => {
    const k = String(i).padStart(4, "0");
    return { id: `d${k}`, number: i % 3 === 0 ? `re-${k}` : i % 3 === 1 ? `RE-${k}` : `Re${k}` };
  });
  for (const dir of ["asc", "desc"] as const) {
    it(`> 900 Ids, number ${dir}: Treffer an Blockgrenzen stimmen mit der JS-Ordnung ueberein`, async () => {
      const compare = compareBySort<NumRow>({ key: "number", dir, nulls: "last" }, (r) => r.number);
      const reference = [...rows].sort(compare);
      const ids = rows.map((r) => r.id);
      // Die DB-Stufe liefert (wie Postgres) nach Collation sortiert; ein top-N waere hier falsch.
      const keys = vi.fn(async (c: IdCond) => rows.filter((r) => c?.id.in.includes(r.id)).sort(dbCollate));
      const byIds = async (pageIds: string[]) => rows.filter((r) => pageIds.includes(r.id));
      for (const [offset, limit] of [[0, 25], [880, 50], [895, 20], [1790, 60]] as const) {
        const page = await pageByIdSet<NumRow, NumRow>(ids, { offset, limit, compare, single: async () => [], keys, byIds });
        expect(page.map((r) => r.id)).toEqual(reference.slice(offset, offset + limit).map((r) => r.id));
      }
      const first = await orderedIdsByIdSet<NumRow>(ids, { limit: 1000, compare, keys });
      expect(first).toEqual(reference.slice(0, 1000).map((r) => r.id));
      // Jeder Block-Aufruf bekommt kein take: alle Schluessel je Block.
      expect(keys.mock.calls.every((call) => call.length === 1)).toBe(true);
    });
  }
});

describe("orderedIdsByIdSet", () => {
  const all = dataset(7);
  const compare = compareBySort<Row>({ key: "v", dir: "asc", nulls: "last" }, (r) => r.v);
  it("entspricht dem Referenzergebnis fuer jedes limit", async () => {
    const reference = [...all].sort(compare).map((r) => r.id);
    const ids = all.map((r) => r.id);
    for (let limit = 1; limit <= 9; limit++) {
      const out = await orderedIdsByIdSet<Row>(ids, { limit, compare, keys: async (c, take) => all.filter((r) => c?.id.in.includes(r.id)).sort(compare).slice(0, take) }, 3);
      expect(out).toEqual(reference.slice(0, limit));
    }
  });
  it("null: eine Abfrage; leer: keine", async () => {
    const keys = vi.fn(async () => [{ id: "a", v: 1 }]);
    expect(await orderedIdsByIdSet(null, { limit: 5, compare, keys })).toEqual(["a"]);
    expect(keys).toHaveBeenCalledTimes(1);
    keys.mockClear();
    expect(await orderedIdsByIdSet([], { limit: 5, compare, keys })).toEqual([]);
    expect(keys).not.toHaveBeenCalled();
  });
});
