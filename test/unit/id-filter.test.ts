import { describe, it, expect, vi } from "vitest";
import { chunkIds, intersectIdSets, countByIdSet, collectByIdSet, compareBySort, pageByIdSet, type IdCond, type SortSpec } from "@/lib/id-filter";

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
              keys: async (c, take) => all.filter((r) => c?.id.in.includes(r.id)).sort(compare).slice(0, take),
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
