// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { FilterBar, type FilterField } from "@/components/list/FilterBar";

const FIELDS: FilterField[] = [
  { type: "text", name: "q", label: "Suche" },
  { type: "combo", name: "customerId", label: "Kunde", selected: { id: "k9", label: "Zander AG" } },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  replace.mockClear();
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("q=zan")) return json([{ id: "k9", name: "Zander AG", customerNumber: "KD-9", city: "Ulm", email: null, isArchived: false }]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("FilterBar: Kundenfeld als Such-Auswahl", () => {
  it("zeigt Combobox + verstecktes Feld customerId mit der Kunden-Id und dem Namen des gewählten Kunden", async () => {
    const { container } = render(<FilterBar basePath="/rechnungen" fields={FIELDS} values={{ customerId: "k9" }} />);
    await advance(0);
    const box = screen.getAllByRole("combobox").find((el) => (el as HTMLInputElement).getAttribute("aria-label") === "Kunde") as HTMLInputElement;
    expect(box.value).toBe("Zander AG");
    const hidden = container.querySelector('input[type="hidden"][name="customerId"]') as HTMLInputElement;
    expect(hidden.value).toBe("k9");
    // Kein Kunden-Abruf nötig: Name kommt von der Seite.
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("ids=k9"), expect.anything());
  });

  it("Suchen und Wählen navigiert mit der Kunden-Id; ohne Auswahl bleibt das Feld leer", async () => {
    render(<FilterBar basePath="/rechnungen" fields={FIELDS} values={{}} />);
    const box = screen.getAllByRole("combobox").find((el) => el.getAttribute("aria-label") === "Kunde") as HTMLInputElement;
    expect(box.value).toBe("");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "zan" } });
    await advance(250);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(replace).toHaveBeenCalledWith("/rechnungen?customerId=k9", { scroll: false });
  });
});
