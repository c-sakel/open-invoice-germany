/**
 * Spaltenaufloesung fuer konfigurierbare Layouts (Phase 16g): rein, ohne pdfkit.
 */
import type { LayoutColumnKey } from "@/schemas/layout-design";
import type { FooterColumn } from "./types";

export interface ResolvedColumn {
  key: LayoutColumnKey;
  /** x relativ zum Tabellenanfang. */
  x: number;
  width: number;
}

/**
 * Verteilt die Inhaltsbreite auf die sichtbaren Spalten in Konfigurationsreihenfolge.
 * Unsichtbare Spalten entfallen; ihr Anteil faellt (zusammen mit dem Rundungsrest) an die
 * Beschreibung. Summe aus Breiten und Luecken ist exakt `contentWidth`.
 */
export function resolveConfiguredColumns(
  columns: readonly { key: LayoutColumnKey; widthPct: number }[],
  visible: Record<LayoutColumnKey, boolean>,
  contentWidth: number,
  gap: number,
): ResolvedColumn[] {
  const shown = columns.filter((c) => visible[c.key]);
  if (shown.length === 0) return [];
  const available = contentWidth - gap * (shown.length - 1);
  const widths = shown.map((c) => (c.key === "description" ? 0 : Math.floor((c.widthPct / 100) * available)));
  const rest = available - widths.reduce((s, w) => s + w, 0);
  let sink = shown.findIndex((c) => c.key === "description");
  if (sink < 0) sink = shown.length - 1;
  widths[sink] = (widths[sink] ?? 0) + rest;
  let x = 0;
  return shown.map((c, i) => {
    const width = widths[i] ?? 0;
    const col = { key: c.key, x, width };
    x += width + gap;
    return col;
  });
}

/**
 * Legt Fusszeilen-Spalten der Reihe nach auf `count` Spalten zusammen (Zeilen werden
 * angehaengt). `fullWidth`-Spalten bleiben unberuehrt und stehen weiter hinten.
 */
export function mergeFooterColumns(columns: FooterColumn[], count: number): FooterColumn[] {
  const grid = columns.filter((c) => !c.fullWidth && c.lines.length > 0);
  const rows = columns.filter((c) => c.fullWidth);
  if (count < 1 || grid.length <= count) return columns;
  const merged: FooterColumn[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * grid.length) / count);
    const to = Math.floor(((i + 1) * grid.length) / count);
    merged.push({ lines: grid.slice(from, to).flatMap((c) => c.lines) });
  }
  return [...merged, ...rows];
}
