"use client";

import { LAYOUT_COLUMN_KEYS, type LayoutColumnKey } from "@/schemas/layout-design";
import { REQUIRED_COLUMNS, columnSum, moveColumn, toggleColumn, type FieldErrors, type LayoutColumn } from "@/lib/layout-design/editor";
import { NumberField } from "./NumberField";

export const COLUMN_LABELS: Record<LayoutColumnKey, string> = {
  pos: "Pos.",
  article: "Artikelnummer",
  description: "Beschreibung",
  qty: "Menge",
  unit: "Einheit",
  unitPrice: "Einzelpreis",
  taxRate: "Steuersatz",
  discount: "Rabatt",
  total: "Gesamt",
};

export function ColumnTable({
  columns,
  errors,
  onChange,
}: {
  columns: LayoutColumn[];
  errors: FieldErrors;
  onChange: (next: LayoutColumn[]) => void;
}) {
  const sum = columnSum(columns);
  const absent = LAYOUT_COLUMN_KEYS.filter((k) => !columns.some((c) => c.key === k));
  const messages = Object.entries(errors)
    .filter(([path]) => path === "columns" || path.startsWith("columns."))
    .flatMap(([, list]) => list);

  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {columns.map((col, index) => {
          const label = COLUMN_LABELS[col.key];
          const required = REQUIRED_COLUMNS.includes(col.key);
          return (
            <li key={col.key} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] bg-well px-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked
                disabled={required}
                onChange={() => onChange(toggleColumn(columns, col.key))}
                aria-label={`Spalte ${label} anzeigen`}
              />
              <span className="min-w-28 flex-1 text-ink">{label}</span>
              <NumberField
                label={`Breite ${label} (%)`}
                value={col.widthPct}
                step={1}
                onChange={(n) => onChange(columns.map((c) => (c.key === col.key ? { ...c, widthPct: n } : c)))}
                className="w-16"
                hideLabel
              />
              <button
                type="button"
                disabled={index === 0}
                onClick={() => onChange(moveColumn(columns, col.key, "up"))}
                aria-label={`${label} nach oben`}
                className="rounded px-1.5 text-ink-muted hover:bg-sheet disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={index === columns.length - 1}
                onClick={() => onChange(moveColumn(columns, col.key, "down"))}
                aria-label={`${label} nach unten`}
                className="rounded px-1.5 text-ink-muted hover:bg-sheet disabled:opacity-30"
              >
                ↓
              </button>
            </li>
          );
        })}
      </ul>
      {absent.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs text-ink-muted">
          {absent.map((key) => (
            <li key={key}>
              <label className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 ring-1 ring-inset ring-rule-strong">
                <input type="checkbox" checked={false} onChange={() => onChange(toggleColumn(columns, key))} aria-label={`Spalte ${COLUMN_LABELS[key]} anzeigen`} />
                {COLUMN_LABELS[key]}
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className={`text-sm ${sum === 100 ? "text-ink-muted" : "text-stamp"}`}>Summe: {sum} %</p>
      {messages.map((m) => (
        <p key={m} role="alert" className="text-sm text-stamp">
          {m}
        </p>
      ))}
    </div>
  );
}
