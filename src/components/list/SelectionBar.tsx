"use client";

import type { ReactNode } from "react";
import { useListSelectionContext } from "./ListSelection";

/** Aktionsleiste der Mehrfachauswahl; rendert nichts ohne Auswahl und vor dem Mount. */
export function SelectionBar({
  noun,
  children,
}: {
  noun: [singular: string, plural: string];
  children: (selected: string[], clear: () => void) => ReactNode;
}) {
  const { selected, selectable, mounted, dispatch } = useListSelectionContext();
  if (!mounted || selected.length === 0) return null;
  const clear = () => dispatch({ type: "clear" });
  return (
    <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md bg-well px-3 py-2 text-sm" role="region" aria-label={`Auswahl ${noun[1]}`}>
      <span aria-live="polite" className="font-medium text-ink">
        {selected.length} ausgewählt
      </span>
      {selected.length < selectable.length && (
        <button type="button" onClick={() => dispatch({ type: "selectAll" })} className="text-pen hover:underline">
          Alle auf dieser Seite
        </button>
      )}
      <button type="button" onClick={clear} className="text-pen hover:underline">
        Auswahl aufheben
      </button>
      <span className="ml-auto">{children(selected, clear)}</span>
    </div>
  );
}
