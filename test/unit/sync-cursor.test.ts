import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  decodeSyncCursor,
  encodeSyncCursor,
  nextSyncCursor,
  resolveSyncWindow,
  syncFilterShape,
  syncWhere,
  SYNC_CURSOR_MAX,
} from "@/domain/sync/updated-since";

function zodFail(fn: () => unknown): z.ZodError {
  try {
    fn();
  } catch (e) {
    if (e instanceof z.ZodError) return e;
    throw e;
  }
  throw new Error("kein ZodError");
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("Abgleich-Cursor", () => {
  it("Roundtrip erhaelt Millisekunden und Id", () => {
    const c = { updatedAt: new Date("2190-03-01T09:00:00.123Z"), id: "cabc123_x-Y" };
    const back = decodeSyncCursor(encodeSyncCursor(c));
    expect(back.updatedAt.getTime()).toBe(c.updatedAt.getTime());
    expect(back.id).toBe(c.id);
    expect(encodeSyncCursor(c).startsWith("v1.")).toBe(true);
  });

  const bad: Array<[string, string]> = [
    ["ohne Praefix", b64("2190-03-01T09:00:00.000Z|abc")],
    ["kaputtes base64url", "v1.***"],
    ["ISO ohne Zone", "v1." + b64("2190-03-01T09:00:00.000|abc")],
    ["Id mit Apostroph", "v1." + b64("2190-03-01T09:00:00.000Z|a'b")],
    ["Id mit Leerzeichen", "v1." + b64("2190-03-01T09:00:00.000Z|a b")],
    ["zu lang", "v1." + b64(`2190-03-01T09:00:00.000Z|${"a".repeat(SYNC_CURSOR_MAX)}`)],
    ["ohne Trenner", "v1." + b64("2190-03-01T09:00:00.000Zabc")],
    ["leerer Rumpf", "v1."],
  ];
  it.each(bad)("lehnt ab: %s", (_name, raw) => {
    const err = zodFail(() => decodeSyncCursor(raw));
    expect(err.issues[0].path).toEqual(["cursor"]);
    expect(err.issues[0].message).toBe("Ungültiger Cursor.");
    expect(JSON.stringify(err.issues)).not.toContain(raw);
  });
});

describe("resolveSyncWindow", () => {
  it("normalisiert die Zone auf UTC", () => {
    const w = resolveSyncWindow({ updatedSince: "2190-03-01T10:00:00+01:00" }, { updatedSince: "2190-03-01T10:00:00+01:00", offset: 0 });
    expect(w?.since.toISOString()).toBe("2190-03-01T09:00:00.000Z");
    expect(w?.after).toBeNull();
  });
  it("ohne updatedSince: null", () => {
    expect(resolveSyncWindow({}, { offset: 0 })).toBeNull();
    expect(resolveSyncWindow({ sort: "gross_desc" }, { offset: 3 })).toBeNull();
  });
  it("cursor ohne updatedSince -> ZodError", () => {
    expect(zodFail(() => resolveSyncWindow({ cursor: "x" }, { cursor: "x", offset: 0 })).issues[0].path).toEqual(["cursor"]);
  });
  it("offset > 0 -> ZodError", () => {
    const err = zodFail(() => resolveSyncWindow({}, { updatedSince: "2190-03-01T10:00:00Z", offset: 5 }));
    expect(err.issues[0].path).toEqual(["offset"]);
    expect(err.issues[0].message).toBe("Mit updatedSince bitte cursor statt offset verwenden.");
  });
  it("sort im Rohfilter -> ZodError", () => {
    const err = zodFail(() => resolveSyncWindow({ sort: "gross_desc" }, { updatedSince: "2190-03-01T10:00:00Z", offset: 0 }));
    expect(err.issues[0].path).toEqual(["sort"]);
  });
  it("Cursor wird aufgeloest", () => {
    const cursor = encodeSyncCursor({ updatedAt: new Date("2190-03-01T09:30:00.000Z"), id: "abc" });
    const w = resolveSyncWindow({}, { updatedSince: "2190-03-01T09:00:00Z", cursor, offset: 0 });
    expect(w?.after?.id).toBe("abc");
    expect(syncWhere(w!).AND).toHaveLength(2);
  });
  it("updatedSince braucht eine Zone", () => {
    expect(z.object(syncFilterShape).safeParse({ updatedSince: "2190-03-01T10:00:00" }).success).toBe(false);
    expect(z.object(syncFilterShape).safeParse({ updatedSince: "2190-03-01T10:00:00Z" }).success).toBe(true);
  });
});

describe("nextSyncCursor", () => {
  const rows = [
    { id: "a", updatedAt: new Date("2190-01-01T00:00:00.000Z") },
    { id: "b", updatedAt: new Date("2190-01-02T00:00:00.000Z") },
  ];
  it("volle Seite -> Cursor der letzten Zeile", () => {
    const c = nextSyncCursor(rows, 2);
    expect(c).not.toBeNull();
    expect(decodeSyncCursor(c!)).toEqual({ updatedAt: rows[1].updatedAt, id: "b" });
  });
  it("kuerzere Seite -> null", () => {
    expect(nextSyncCursor(rows, 3)).toBeNull();
    expect(nextSyncCursor([], 1)).toBeNull();
  });
});
