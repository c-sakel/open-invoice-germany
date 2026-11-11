/** Phase 16a, Task 6 — Kettenpruefung (Domain) gegen eine In-Memory-Datenquelle. */
import { describe, expect, it, vi } from "vitest";

const broken = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/domain/notifications/hooks", () => ({ onChainBroken: broken }));

import { canonicalize, computeEntryHash, type ChangeLogPayload } from "@/domain/changelog";
import { CHAIN_VERIFY_BLOCK, verifyOrgChain } from "@/domain/audit/verify-chain";
import type { dbInternal } from "@/lib/db";

interface Row {
  id: number;
  entity: string;
  entityId: string;
  action: string;
  actor: string;
  at: Date;
  diffJson: string;
  prevHash: string;
  hash: string;
}

/** Baut Eintraege exakt wie appendChangeLog (Payload mit at.toISOString(), diffJson = canonicalize). */
function build(n: number): Row[] {
  const rows: Row[] = [];
  let prev = "";
  for (let i = 1; i <= n; i++) {
    const at = new Date(Date.UTC(2090, 0, 1, 0, 0, i));
    const diff = { n: i, text: `Eintrag ${i}` };
    const payload: ChangeLogPayload = { entity: "INVOICE", entityId: `inv-${i}`, action: "UPDATE", actor: "test", at: at.toISOString(), diff };
    const hash = computeEntryHash(prev, payload);
    rows.push({ id: i * 3, entity: "INVOICE", entityId: `inv-${i}`, action: "UPDATE", actor: "test", at, diffJson: canonicalize(diff), prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

function fakeDb(rows: Row[], previous: { valid: boolean; entries: number; lastHash: string }[] = []) {
  const created: unknown[] = [...previous];
  const db = {
    changeLog: {
      findMany: async (args: { where: { id: { gt: number } }; take: number }) =>
        rows.filter((r) => r.id > args.where.id.gt).sort((a, b) => a.id - b.id).slice(0, args.take),
    },
    chainVerification: {
      create: async (args: { data: unknown }) => void created.push(args.data),
      findFirst: async () => [...(previous as { valid: boolean }[])].reverse().find((p) => p.valid) ?? null,
    },
  };
  return { db: db as unknown as typeof dbInternal, created };
}

describe("verifyOrgChain", () => {
  it("intakte Kette ist gueltig und wird protokolliert", async () => {
    const rows = build(5);
    const { db, created } = fakeDb(rows);
    const r = await verifyOrgChain("o", "API", db);
    expect(r).toMatchObject({ valid: true, entries: 5, brokenEntryId: null, lastHash: rows[4].hash });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ orgId: "o", valid: true, entries: 5, trigger: "API" });
  });

  it("leere Kette ist gueltig", async () => {
    const r = await verifyOrgChain("o", "UI", fakeDb([]).db);
    expect(r).toMatchObject({ valid: true, entries: 0, lastHash: "" });
  });

  it("geaenderter diffJson -> Bruch an dieser Zeile, Alarm", async () => {
    const rows = build(5);
    rows[2] = { ...rows[2], diffJson: canonicalize({ n: 3, text: "manipuliert" }) };
    broken.mockClear();
    const r = await verifyOrgChain("o", "API", fakeDb(rows).db);
    expect(r).toMatchObject({ valid: false, brokenEntryId: rows[2].id, entries: 2 });
    expect(broken).toHaveBeenCalledWith("o", expect.objectContaining({ brokenEntryId: rows[2].id }));
  });

  it("geloeschte Zeile -> Bruch an der Folgezeile", async () => {
    const rows = build(5);
    const folge = rows[3].id;
    rows.splice(2, 1);
    const r = await verifyOrgChain("o", "API", fakeDb(rows).db);
    expect(r).toMatchObject({ valid: false, brokenEntryId: folge });
  });

  it("vertauschte Reihenfolge -> Bruch", async () => {
    const rows = build(5);
    const a = rows[1].id;
    const b = rows[2].id;
    rows[1] = { ...rows[1], id: b };
    rows[2] = { ...rows[2], id: a };
    const r = await verifyOrgChain("o", "API", fakeDb(rows).db);
    expect(r.valid).toBe(false);
    expect(r.brokenEntryId).toBe(a); // an Position 2 steht jetzt die urspruengliche Zeile 3 (id a)
  });

  it("Kette ueber die Blockgrenze (> 1000) bleibt gueltig", async () => {
    const rows = build(CHAIN_VERIFY_BLOCK * 2 + 37);
    const r = await verifyOrgChain("o", "SCHEDULER", fakeDb(rows).db);
    expect(r).toMatchObject({ valid: true, entries: rows.length, lastHash: rows[rows.length - 1].hash });
  });

  it("Bruch hinter der Blockgrenze wird gefunden", async () => {
    const rows = build(CHAIN_VERIFY_BLOCK + 5);
    const idx = CHAIN_VERIFY_BLOCK + 2;
    rows[idx] = { ...rows[idx], diffJson: "{}" };
    const r = await verifyOrgChain("o", "SCHEDULER", fakeDb(rows).db);
    expect(r).toMatchObject({ valid: false, brokenEntryId: rows[idx].id, entries: idx });
  });

  it("unparsebarer diffJson ist sofort ein Bruch", async () => {
    const rows = build(4);
    rows[1] = { ...rows[1], diffJson: "{kaputt" };
    const r = await verifyOrgChain("o", "API", fakeDb(rows).db);
    expect(r).toMatchObject({ valid: false, brokenEntryId: rows[1].id, entries: 1 });
  });

  describe("Abschneiden gegenueber der letzten gueltigen Pruefung", () => {
    it("letzte Zeilen geloescht -> Bruch an der letzten verbleibenden Zeile, Alarm", async () => {
      const rows = build(6);
      const prevOk = { valid: true, entries: 6, lastHash: rows[5].hash };
      const truncated = rows.slice(0, 4);
      broken.mockClear();
      const r = await verifyOrgChain("o", "SCHEDULER", fakeDb(truncated, [prevOk]).db);
      expect(r).toMatchObject({ valid: false, brokenEntryId: truncated[3].id, entries: 4 });
      expect(broken).toHaveBeenCalledTimes(1);
    });

    it("alle Zeilen geloescht -> Bruch (id 0)", async () => {
      const rows = build(3);
      const r = await verifyOrgChain("o", "SCHEDULER", fakeDb([], [{ valid: true, entries: 3, lastHash: rows[2].hash }]).db);
      expect(r).toMatchObject({ valid: false, brokenEntryId: 0, entries: 0 });
    });

    it("mittlere Zeile geloescht -> Bruch", async () => {
      const rows = build(6);
      const prevOk = { valid: true, entries: 6, lastHash: rows[5].hash };
      const folge = rows[3].id;
      rows.splice(2, 1);
      const r = await verifyOrgChain("o", "SCHEDULER", fakeDb(rows, [prevOk]).db);
      expect(r).toMatchObject({ valid: false, brokenEntryId: folge });
    });

    it("anderer Hash an der frueheren Endposition -> Bruch; gewachsene Kette bleibt gueltig", async () => {
      const rows = build(6);
      const wrong = await verifyOrgChain("o", "API", fakeDb(rows, [{ valid: true, entries: 4, lastHash: "falsch" }]).db);
      expect(wrong).toMatchObject({ valid: false, brokenEntryId: rows[3].id, entries: 3 });
      const grown = await verifyOrgChain("o", "API", fakeDb(rows, [{ valid: true, entries: 4, lastHash: rows[3].hash }]).db);
      expect(grown).toMatchObject({ valid: true, entries: 6 });
    });

    it("eine fruehere ungueltige Pruefung dient nicht als Anker", async () => {
      const rows = build(3);
      const r = await verifyOrgChain("o", "API", fakeDb(rows, [{ valid: false, entries: 9, lastHash: "x" }]).db);
      expect(r.valid).toBe(true);
    });
  });
});
