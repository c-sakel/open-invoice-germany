import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { selectionReducer } from "@/components/list/use-list-selection";
import { ListSelectionProvider, SelectionCheckbox } from "@/components/list/ListSelection";
import { SelectionBar } from "@/components/list/SelectionBar";

const base = { selectable: ["a", "b", "c"], selected: [] as string[] };

describe("selectionReducer", () => {
  it("toggle wählt an und ab, nicht wählbare Ids werden ignoriert", () => {
    const s1 = selectionReducer(base, { type: "toggle", id: "a" });
    expect(s1.selected).toEqual(["a"]);
    expect(selectionReducer(s1, { type: "toggle", id: "a" }).selected).toEqual([]);
    expect(selectionReducer(base, { type: "toggle", id: "x" })).toBe(base);
  });
  it("selectAll wählt nur selectable", () => {
    expect(selectionReducer(base, { type: "selectAll" }).selected).toEqual(["a", "b", "c"]);
  });
  it("sync entfernt nicht mehr vorhandene Ids", () => {
    const s = selectionReducer({ ...base, selected: ["a", "c"] }, { type: "sync", selectable: ["c", "d"] });
    expect(s).toEqual({ selectable: ["c", "d"], selected: ["c"] });
  });
  it("clear leert die Auswahl", () => {
    expect(selectionReducer({ ...base, selected: ["a"] }, { type: "clear" }).selected).toEqual([]);
  });
});

describe("Server-Render", () => {
  it("rendert ohne JS keine Checkbox und keine Leiste", () => {
    const html = renderToStaticMarkup(
      <ListSelectionProvider selectableIds={["a"]}>
        <SelectionCheckbox id="a" label="RE-1 auswählen" />
        <SelectionBar noun={["Rechnung", "Rechnungen"]}>{() => "X"}</SelectionBar>
      </ListSelectionProvider>,
    );
    expect(html).not.toContain("<input");
    expect(html).toBe("");
  });
});
