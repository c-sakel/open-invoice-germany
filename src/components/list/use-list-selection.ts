import { useReducer } from "react";

export type SelectionState = { selectable: string[]; selected: string[] };
export type SelectionAction =
  | { type: "toggle"; id: string }
  | { type: "selectAll" }
  | { type: "clear" }
  | { type: "sync"; selectable: readonly string[] };

/** Reiner Reducer der Listenauswahl: gewaehlt werden kann nur, was in `selectable` steht. */
export function selectionReducer(state: SelectionState, a: SelectionAction): SelectionState {
  switch (a.type) {
    case "toggle": {
      if (!state.selectable.includes(a.id)) return state;
      const selected = state.selected.includes(a.id) ? state.selected.filter((x) => x !== a.id) : [...state.selected, a.id];
      return { ...state, selected };
    }
    case "selectAll":
      return { ...state, selected: [...state.selectable] };
    case "clear":
      return { ...state, selected: [] };
    case "sync": {
      const selectable = [...a.selectable];
      return { selectable, selected: state.selected.filter((x) => selectable.includes(x)) };
    }
  }
}

export function useListSelection(selectable: readonly string[]) {
  return useReducer(selectionReducer, { selectable: [...selectable], selected: [] });
}
