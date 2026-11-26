// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchSelect, type SearchSelectOption } from "@/components/ui/SearchSelect";
import { readRecent } from "@/components/ui/use-recent";

const OPTS: SearchSelectOption[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
];

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => cleanup());

async function pickFirst(onChange: () => void | boolean | Promise<void | boolean>) {
  render(<SearchSelect label="Kunde" value={null} options={OPTS} recentKey="t" onChange={onChange} />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "Enter" });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SearchSelect: Zuletzt verwendet erst nach angenommener Auswahl", () => {
  it("merkt die Auswahl, wenn onChange nichts oder true liefert", async () => {
    await pickFirst(() => undefined);
    expect(readRecent("t")).toEqual(["a"]);
    window.localStorage.clear();
    cleanup();
    await pickFirst(async () => true);
    expect(readRecent("t")).toEqual(["a"]);
  });

  it("merkt die Auswahl nicht, wenn der Aufrufer sie ablehnt (false, auch asynchron)", async () => {
    await pickFirst(() => false);
    expect(readRecent("t")).toEqual([]);
    cleanup();
    await pickFirst(async () => false);
    expect(readRecent("t")).toEqual([]);
  });

  it("merkt die Auswahl nicht, wenn der Aufrufer wirft oder die Zusage scheitert", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await pickFirst(() => Promise.reject(new Error("x")));
    expect(readRecent("t")).toEqual([]);
    err.mockRestore();
  });
});
