/** Phase 16g, Task 4 — Spaltenaufloesung konfigurierbarer Layouts (rein). */
import { describe, it, expect } from "vitest";
import { resolveConfiguredColumns, mergeFooterColumns } from "@/lib/pdf/layouts/columns";
import { DEFAULT_COLUMNS, LAYOUT_COLUMN_KEYS, type LayoutColumnKey } from "@/schemas/layout-design";

const ALL = Object.fromEntries(LAYOUT_COLUMN_KEYS.map((k) => [k, true])) as Record<LayoutColumnKey, boolean>;
const sum = (cols: { width: number }[], gap: number) => cols.reduce((s, c) => s + c.width, 0) + gap * (cols.length - 1);

describe("resolveConfiguredColumns", () => {
  it("alles sichtbar: Breiten + Luecken = Inhaltsbreite", () => {
    const cols = resolveConfiguredColumns(DEFAULT_COLUMNS, ALL, 500, 8);
    expect(cols).toHaveLength(7);
    expect(sum(cols, 8)).toBe(500);
    expect(cols[0]?.x).toBe(0);
  });

  it("unsichtbare Artikelspalte: Beschreibung wird breiter", () => {
    const full = resolveConfiguredColumns(DEFAULT_COLUMNS, ALL, 500, 8);
    const cols = resolveConfiguredColumns(DEFAULT_COLUMNS, { ...ALL, article: false }, 500, 8);
    expect(cols).toHaveLength(6);
    expect(cols.some((c) => c.key === "article")).toBe(false);
    const widthOf = (list: typeof cols) => list.find((c) => c.key === "description")?.width ?? 0;
    expect(widthOf(cols)).toBeGreaterThan(widthOf(full) + 40);
    expect(sum(cols, 8)).toBe(500);
  });

  it("Summe bleibt exakt bei mehreren unsichtbaren Spalten", () => {
    const cols = resolveConfiguredColumns(DEFAULT_COLUMNS, { ...ALL, total: false, taxRate: false }, 497, 8);
    expect(cols.map((c) => c.key)).toEqual(["pos", "article", "description", "qty", "unitPrice"]);
    expect(sum(cols, 8)).toBe(497);
  });

  it("behaelt die Reihenfolge der Konfiguration und liefert aufsteigende x", () => {
    const reordered = [DEFAULT_COLUMNS[2]!, DEFAULT_COLUMNS[0]!, ...DEFAULT_COLUMNS.slice(3), DEFAULT_COLUMNS[1]!];
    const cols = resolveConfiguredColumns(reordered, ALL, 500, 8);
    expect(cols.map((c) => c.key)).toEqual(reordered.map((c) => c.key));
    for (let i = 1; i < cols.length; i++) expect(cols[i]!.x).toBe(cols[i - 1]!.x + cols[i - 1]!.width + 8);
  });
});

describe("mergeFooterColumns", () => {
  const cols = [{ lines: ["a"] }, { lines: ["b"] }, { lines: ["c"] }, { lines: ["d"] }, { lines: ["Inhaber X"], fullWidth: true }];
  it("legt der Reihe nach zusammen, fullWidth bleibt", () => {
    const merged = mergeFooterColumns(cols, 2);
    expect(merged.map((c) => c.lines)).toEqual([["a", "b"], ["c", "d"], ["Inhaber X"]]);
    expect(merged[2]?.fullWidth).toBe(true);
  });
  it("ohne Ueberhang unveraendert", () => {
    expect(mergeFooterColumns(cols, 4)).toBe(cols);
  });
});
