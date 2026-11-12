"use client";

/**
 * Reihenfolge der Belegbloecke (Phase 16g). Sortieren wie die Positionen im Editor (13b):
 * Zeiger mit 4-px-Schwelle, Touch-Long-Press, Tastatur (Leertaste/Enter, Pfeile, Escape);
 * Indexlogik aus `@/lib/editor/reorder`. Die drei Kopfbloecke haben keinen Griff.
 */
import { useMemo } from "react";
import type { LayoutBlockKey } from "@/schemas/layout-design";
import { slotToMoveTarget } from "@/lib/editor/reorder";
import { ALWAYS_PRINTED_BLOCKS, FIXED_HEAD_COUNT, OPTIONAL_BLOCKS, moveBlock, toggleBlock } from "@/lib/layout-design/editor";
import { useReorder, type ReorderItem } from "@/components/editor/blocks/use-pointer-reorder";

export const BLOCK_LABELS: Record<LayoutBlockKey, string> = {
  sender: "Absender",
  recipient: "Empfänger",
  meta: "Belegdaten",
  subject: "Betreff",
  intro: "Einleitungstext",
  lines: "Positionen",
  totals: "Summen",
  giro: "GiroCode",
  outro: "Fußtext",
  payment: "Zahlungshinweise",
};

export function BlockOrderList({
  blocks,
  errors,
  onChange,
}: {
  blocks: LayoutBlockKey[];
  errors: string[];
  onChange: (next: LayoutBlockKey[]) => void;
}) {
  const items = useMemo<ReorderItem[]>(() => blocks.map((key) => ({ key, lineType: "ITEM" })), [blocks]);
  const reorder = useReorder(
    items,
    ({ key, slot }) => {
      const from = blocks.indexOf(key as LayoutBlockKey);
      if (from < 0) return;
      onChange(moveBlock(blocks, key as LayoutBlockKey, slotToMoveTarget(from, slot)));
    },
    FIXED_HEAD_COUNT,
  );
  const hidden = OPTIONAL_BLOCKS.filter((k) => !blocks.includes(k));

  return (
    <div className="space-y-2">
      <ol className="space-y-1.5">
        {blocks.map((key, index) => {
          const fixed = index < FIXED_HEAD_COUNT;
          const optional = OPTIONAL_BLOCKS.includes(key);
          const label = BLOCK_LABELS[key];
          const props = reorder.handleProps(key, index);
          return (
            <li
              key={key}
              ref={(el) => reorder.registerRow(key, el)}
              className={`flex items-center gap-2 rounded-[var(--radius-control)] bg-well px-2 py-1.5 text-sm ${
                reorder.activeKeys?.has(key) ? "opacity-50 outline outline-2 -outline-offset-2 outline-pen" : ""
              }`}
            >
              {fixed ? (
                <span aria-hidden="true" className="inline-flex h-8 w-8 items-center justify-center text-ink-muted">
                  🔒
                </span>
              ) : (
                <button
                  type="button"
                  {...props}
                  aria-label={`${label} verschieben`}
                  title="Ziehen zum Sortieren, oder Leertaste und Pfeiltasten"
                  className="inline-flex h-8 w-8 cursor-grab touch-none select-none items-center justify-center rounded text-ink-muted hover:bg-sheet hover:text-ink-soft [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                >
                  ⠿
                </button>
              )}
              <span className="flex-1 text-ink">{label}</span>
              {fixed && <span className="text-xs text-ink-muted">fest (DIN 5008)</span>}
              {!fixed && !optional && (
                <span className="text-xs text-ink-muted">{ALWAYS_PRINTED_BLOCKS.includes(key) ? "nur Position, Inhalt wird immer gedruckt" : "Pflicht"}</span>
              )}
              {optional && (
                <button
                  type="button"
                  onClick={() => onChange(toggleBlock(blocks, key))}
                  className="text-xs text-ink-muted hover:text-stamp"
                  aria-label={`${label} ausblenden`}
                >
                  Ausblenden
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {hidden.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          Ausgeblendet:
          {hidden.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => onChange(toggleBlock(blocks, key))}
              className="rounded-full px-2 py-0.5 ring-1 ring-inset ring-rule-strong hover:bg-well"
              aria-label={`${BLOCK_LABELS[key]} einblenden`}
            >
              + {BLOCK_LABELS[key]}
            </button>
          ))}
        </p>
      )}
      {errors.map((m) => (
        <p key={m} role="alert" className="text-sm text-stamp">
          {m}
        </p>
      ))}
      {reorder.indicator && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-40 h-0.5 bg-pen"
          style={{ top: reorder.indicator.top - 1, left: reorder.indicator.left, width: reorder.indicator.width }}
        />
      )}
      <div aria-live="polite" role="status" className="sr-only">
        {reorder.announcement}
      </div>
    </div>
  );
}
