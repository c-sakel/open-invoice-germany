import { DEFAULT_BLOCKS, DEFAULT_COLUMNS, type LayoutBlockKey, type LayoutDesignConfig } from "@/schemas/layout-design";
import { getLayout } from "./registry";
import type { LayoutId } from "./ids";

/** `#rgb` -> `#rrggbb` (Bestandslayouts nutzen teils Kurzschreibweise). */
function longHex(color: string): string {
  const m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(color);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : color;
}

/** Leitet aus einem der sieben festen Layouts eine Designkonfiguration als Startvorlage ab. */
export function presetConfig(id: LayoutId): LayoutDesignConfig {
  const layout = getLayout(id);
  const blocks: LayoutBlockKey[] = [];
  for (const key of DEFAULT_BLOCKS) {
    blocks.push(key);
    if (key === "totals" && layout.giroPlacement === "below-totals") blocks.push("giro");
  }
  return {
    version: 1,
    blocks,
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    font: "liberation-sans",
    fontSizePt: 10 + layout.fontDelta,
    colors: {
      primary: "#111111",
      text: longHex(layout.table.textColor),
      muted: "#666666",
      tableHeader: longHex(layout.table.headerFill ?? "#1f2937"),
      rule: longHex(layout.table.rowRule ?? "#999999"),
    },
    logo: { position: "right", widthMm: 40 },
    header: { heightMm: 25 },
    footer: { mode: "AUTO", columns: 4, minHeightMm: 16 },
    table: { zebra: Boolean(layout.table.zebra), rules: Boolean(layout.table.rowRule), headerFill: Boolean(layout.table.headerFill) },
    marginsMm: { top: 15, right: 18, bottom: 20, left: 25 },
  };
}
