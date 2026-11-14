"use client";

/**
 * Mehrfachauswahl fuer Listen (18c). Der Server rendert KEINE Checkboxen (ohne JS gibt es keine
 * Auswahl); sie erscheinen erst nach dem Mount. Die Auswahl lebt nur im Client und wird bei
 * Seitenwechsel (neue `selectableIds`) auf die vorhandenen Ids bereinigt.
 */
import { createContext, useContext, useEffect, useMemo, useReducer, useSyncExternalStore, type ReactNode } from "react";
import { selectionReducer, type SelectionAction } from "./use-list-selection";

interface Ctx {
  selected: string[];
  selectable: string[];
  mounted: boolean;
  dispatch: (a: SelectionAction) => void;
}

const noopSubscribe = () => () => {};

const ListSelectionContext = createContext<Ctx | null>(null);

export function useListSelectionContext(): Ctx {
  const c = useContext(ListSelectionContext);
  if (!c) throw new Error("useListSelectionContext ausserhalb von ListSelectionProvider");
  return c;
}

export function ListSelectionProvider({ selectableIds, children }: { selectableIds: string[]; children: ReactNode }) {
  const [state, dispatch] = useReducer(selectionReducer, { selectable: selectableIds, selected: [] });
  // Server/Hydration: false, danach true (kein setState im Effect).
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const key = selectableIds.join("|");
  useEffect(() => {
    dispatch({ type: "sync", selectable: selectableIds });
    // `key` ersetzt die Array-Identitaet (Server liefert je Render ein neues Array).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const value = useMemo<Ctx>(() => ({ selected: state.selected, selectable: state.selectable, mounted, dispatch }), [state, mounted]);
  return <ListSelectionContext.Provider value={value}>{children}</ListSelectionContext.Provider>;
}

export function SelectionCheckbox({ id, label }: { id: string; label: string }) {
  const { selected, selectable, mounted, dispatch } = useListSelectionContext();
  if (!mounted || !selectable.includes(id)) return null;
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={selected.includes(id)}
      onChange={() => dispatch({ type: "toggle", id })}
      className="h-4 w-4 align-middle"
    />
  );
}
