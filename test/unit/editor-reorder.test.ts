import { describe, it, expect } from "vitest";
import { dropSlot, slotToMoveTarget, blockRange, isNoopMove, autoScrollSpeed } from "@/lib/editor/reorder";

const t = (...types: string[]) => types.map((lineType) => ({ lineType: lineType as "ITEM" }));

describe("dropSlot", () => {
  const mids = [10, 30, 50, 70];
  it("Randfaelle und Zeilenmitte", () => {
    expect(dropSlot(mids, 0)).toBe(0);
    expect(dropSlot(mids, 9)).toBe(0);
    expect(dropSlot(mids, 11)).toBe(1);
    expect(dropSlot(mids, 60)).toBe(3);
    expect(dropSlot(mids, 500)).toBe(4);
    expect(dropSlot([], 5)).toBe(0);
  });
});

describe("slotToMoveTarget", () => {
  it("Zeile 0 auf Slot 3 bei 4 Zeilen landet an Index 2", () => {
    expect(slotToMoveTarget(0, 3)).toBe(2);
  });
  it("aufwaerts bleibt der Slot, Block abwaerts zieht Laenge ab", () => {
    expect(slotToMoveTarget(3, 1)).toBe(1);
    expect(slotToMoveTarget(0, 4)).toBe(3);
    expect(slotToMoveTarget(0, 5, 3)).toBe(2);
  });
});

describe("blockRange", () => {
  it("HEADING bis vor die naechste HEADING", () => {
    const l = t("HEADING", "ITEM", "ITEM", "HEADING", "ITEM");
    expect(blockRange(l, 0)).toEqual([0, 3]);
    expect(blockRange(l, 3)).toEqual([3, 5]);
  });
  it("ITEM, TEXT, SUBTOTAL sind einzeln", () => {
    const l = t("ITEM", "TEXT", "SUBTOTAL");
    expect(blockRange(l, 0)).toEqual([0, 1]);
    expect(blockRange(l, 1)).toEqual([1, 2]);
    expect(blockRange(l, 2)).toEqual([2, 3]);
  });
});

describe("isNoopMove", () => {
  it("Slot = from bzw. from+len und innerhalb des Blocks", () => {
    expect(isNoopMove(2, 2, 1)).toBe(true);
    expect(isNoopMove(2, 3, 1)).toBe(true);
    expect(isNoopMove(2, 1, 1)).toBe(false);
    expect(isNoopMove(2, 4, 1)).toBe(false);
    expect(isNoopMove(1, 3, 3)).toBe(true);
    expect(isNoopMove(1, 4, 3)).toBe(true);
    expect(isNoopMove(1, 5, 3)).toBe(false);
  });
});

describe("autoScrollSpeed", () => {
  it("Rand -> max, Mitte -> 0, Vorzeichen nach Richtung", () => {
    expect(autoScrollSpeed(0, 0, 800)).toBe(-20);
    expect(autoScrollSpeed(800, 0, 800)).toBe(20);
    expect(autoScrollSpeed(400, 0, 800)).toBe(0);
    expect(autoScrollSpeed(24, 0, 800)).toBe(-10);
    expect(autoScrollSpeed(-50, 0, 800)).toBe(-20);
  });
});
