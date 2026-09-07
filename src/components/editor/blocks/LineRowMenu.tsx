"use client";

/**
 * „⋯"-Aktionsmenue je Zeile (Phase 11c, Task 5): Duplizieren / optional Langtext
 * ein-/ausblenden (nur ITEM, siehe `LineRow`) / Entfernen. Gleiches Overlay-Klick-
 * aussen-schliesst-Muster wie `ProductPicker`/`CustomerPicker` (`fixed inset-0`-
 * Button statt `onBlur`, damit ein Klick auf einen Menuepunkt nicht durch ein
 * vorzeitiges Blur verloren geht).
 */
import { useState } from "react";

export function LineRowMenu({
  onDuplicate,
  onRemove,
  canRemove,
  toggleLabel,
  onToggleExpanded,
}: {
  onDuplicate: () => void;
  onRemove: () => void;
  canRemove: boolean;
  toggleLabel?: string;
  onToggleExpanded?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Zeilenaktionen"
        title="Zeilenaktionen"
        className="rounded px-1.5 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
      >
        ⋯
      </button>
      {open && (
        <>
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-0 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-slate-200 bg-white py-1 text-xs shadow-lg">
            <button
              type="button"
              className="block w-full px-3 py-1.5 text-left hover:bg-slate-50"
              onClick={() => {
                onDuplicate();
                setOpen(false);
              }}
            >
              Duplizieren
            </button>
            {onToggleExpanded && toggleLabel && (
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-slate-50"
                onClick={() => {
                  onToggleExpanded();
                  setOpen(false);
                }}
              >
                {toggleLabel}
              </button>
            )}
            <button
              type="button"
              disabled={!canRemove}
              className="block w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                onRemove();
                setOpen(false);
              }}
            >
              Entfernen
            </button>
          </div>
        </>
      )}
    </div>
  );
}
