// Phase 18d, Task 1: Indizes (orgId, updatedAt) fuer den API-Abgleich (SQLite).
import { describe, it, expect } from "vitest";
import { dbInternal } from "@/lib/db";

const TABELLEN = ["Invoice", "Quote", "DeliveryNote", "Customer", "Product"] as const;

interface IndexListRow {
  name: string;
}
interface IndexInfoRow {
  seqno: number;
  name: string;
}

describe("Phase 18d: Indizes (orgId, updatedAt)", () => {
  for (const tabelle of TABELLEN) {
    it(`${tabelle} hat ${tabelle}_orgId_updatedAt_idx mit Spalten orgId, updatedAt`, async () => {
      const indizes = await dbInternal.$queryRawUnsafe<IndexListRow[]>(`PRAGMA index_list("${tabelle}")`);
      const name = `${tabelle}_orgId_updatedAt_idx`;
      expect(indizes.map((i) => i.name)).toContain(name);
      const info = await dbInternal.$queryRawUnsafe<IndexInfoRow[]>(`PRAGMA index_info("${name}")`);
      const spalten = [...info].sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((r) => r.name);
      expect(spalten).toEqual(["orgId", "updatedAt"]);
    });
  }
});
