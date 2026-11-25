// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchSelect, type SearchSelectOption, type SearchSelectProps } from "@/components/ui/SearchSelect";

const OPTS: SearchSelectOption[] = [
  { id: "a", label: "Alpha", subtitle: "K-1" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

function Harness(props: Partial<SearchSelectProps> & { onPick?: (id: string | null) => void }) {
  const [value, setValue] = useState<string | null>(null);
  const { onPick, ...rest } = props;
  return (
    <SearchSelect
      label="Kunde"
      value={value}
      onChange={(id) => {
        setValue(id);
        onPick?.(id);
      }}
      {...rest}
    />
  );
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("SearchSelect", () => {
  it("sucht nach 200 ms genau einmal und bricht die erste Anfrage beim Weitertippen ab", async () => {
    const signals: AbortSignal[] = [];
    const search = vi.fn((q: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<SearchSelectOption[]>(() => undefined);
    });
    render(<Harness search={search} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "be" } });
    await advance(199);
    expect(search).not.toHaveBeenCalled();
    await advance(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe("be");
    fireEvent.change(input(), { target: { value: "bec" } });
    expect(signals[0]?.aborted).toBe(true);
    await advance(200);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("Pfeil runter x2 + Enter wählt die zweite Option, activedescendant folgt", () => {
    const onPick = vi.fn();
    render(<Harness options={OPTS} onPick={onPick} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const active = input().getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active ?? "")?.textContent).toContain("Gamma");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("b");
    expect(input().value).toBe("Beta");
  });

  it("Escape schließt und behält den Fokus; Home/End springen", () => {
    render(<Harness options={OPTS} />);
    input().focus();
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "End" });
    expect(document.getElementById(input().getAttribute("aria-activedescendant") ?? "")?.textContent).toContain("Gamma");
    fireEvent.keyDown(input(), { key: "Home" });
    expect(document.getElementById(input().getAttribute("aria-activedescendant") ?? "")?.textContent).toContain("Alpha");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(input());
  });

  it("zeigt bei leerem Feld die zuletzt verwendeten Ids über loadByIds und führt die Auswahl vorn", async () => {
    window.localStorage.setItem("oig.recent.kunde", JSON.stringify(["c", "a", "x"]));
    const loadByIds = vi.fn(async (ids: string[]) => OPTS.filter((o) => ids.includes(o.id)));
    render(<Harness recentKey="kunde" loadByIds={loadByIds} search={async () => []} />);
    fireEvent.focus(input());
    await advance(0);
    expect(loadByIds).toHaveBeenCalledWith(["c", "a", "x"]);
    expect(screen.getByText("Zuletzt verwendet")).toBeTruthy();
    const opts = screen.getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual(["Gamma", "AlphaK-1"]);
    fireEvent.click(opts[1]!.querySelector("button")!);
    expect(JSON.parse(window.localStorage.getItem("oig.recent.kunde") ?? "[]")).toEqual(["a", "c", "x"]);
  });

  it("begrenzt zuletzt verwendet auf acht Ids", () => {
    window.localStorage.setItem("oig.recent.k", JSON.stringify(["1", "2", "3", "4", "5", "6", "7", "8"]));
    render(<Harness recentKey="k" options={OPTS} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "Enter" });
    const stored: unknown = JSON.parse(window.localStorage.getItem("oig.recent.k") ?? "[]");
    expect(Array.isArray(stored) && stored.length).toBe(8);
    expect(Array.isArray(stored) && stored[0]).toBe("a");
  });

  it("funktioniert, wenn localStorage wirft", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("gesperrt");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("gesperrt");
    });
    const onPick = vi.fn();
    render(<Harness recentKey="k" options={OPTS} onPick={onPick} />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("onCreate erscheint nur bei Eingabe, Enter darauf ruft run(q)", () => {
    const run = vi.fn();
    render(<Harness options={OPTS} onCreate={{ label: "Neuer Kunde", run }} />);
    fireEvent.focus(input());
    expect(screen.queryByText(/Neuer Kunde/)).toBeNull();
    fireEvent.change(input(), { target: { value: "Zeta" } });
    expect(screen.getByText("+ Neuer Kunde „Zeta“")).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(run).toHaveBeenCalledWith("Zeta");
  });

  it("name schreibt die Id ins versteckte Feld; emptyOptionLabel setzt null", () => {
    const { container } = render(<Harness options={OPTS} name="customerId" emptyOptionLabel="— keiner —" />);
    const hidden = container.querySelector<HTMLInputElement>('input[type="hidden"][name="customerId"]');
    expect(hidden?.value).toBe("");
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(hidden?.value).toBe("a");
    fireEvent.focus(input());
    fireEvent.click(screen.getByText("— keiner —"));
    expect(hidden?.value).toBe("");
  });

  it("meldet „Keine Treffer“ im aria-live-Bereich", async () => {
    const { container } = render(<Harness search={async () => []} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: "zzz" } });
    await advance(200);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Keine Treffer");
  });
});
