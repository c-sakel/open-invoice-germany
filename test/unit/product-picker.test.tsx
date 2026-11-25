// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/app/actions/masterdata", () => ({ createProductInline: vi.fn() }));

import { ProductPicker, type ProductOption } from "@/components/editor/ProductPicker";

const LOCAL: ProductOption[] = [
  { id: "p1", name: "Beratung", unit: "HUR", netPriceCents: 9000, taxRate: 19, articleNumber: "A-100" },
  { id: "p2", name: "Lizenz", unit: "C62", netPriceCents: 1500, taxRate: 7, articleNumber: "B-200" },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
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

describe("ProductPicker", () => {
  it("Pfeil/Enter wählt ein Produkt und übergibt Preis, Einheit und Steuersatz unverändert", () => {
    const onPick = vi.fn();
    render(<ProductPicker products={LOCAL} taxRates={[19, 7, 0]} onPick={onPick} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(LOCAL[1]);
  });

  it("die Suche trifft die Artikelnummer (clientseitig bei wenigen Produkten)", () => {
    const onPick = vi.fn();
    render(<ProductPicker products={LOCAL} taxRates={[19]} onPick={onPick} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "A-100" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(LOCAL[0]);
  });

  it("ab 50 Produkten sucht der Picker serverseitig; leere Eingabe zeigt die ersten Einträge", async () => {
    const many: ProductOption[] = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, name: `Artikel ${i}`, unit: "C62", netPriceCents: 100, taxRate: 19 }));
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("q=A-100")) {
        return json([{ id: "p1", name: "Beratung", unit: "HUR", netPriceCents: 9000, taxRate: 19, articleNumber: "A-100", isArchived: false }]);
      }
      return json([{ id: "m0", name: "Artikel 0", unit: "C62", netPriceCents: 100, taxRate: 19, articleNumber: null, isArchived: false }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPick = vi.fn();
    render(<ProductPicker products={many} taxRates={[19]} onPick={onPick} />);
    const box = screen.getByRole("combobox");
    fireEvent.focus(box);
    await advance(0);
    expect(screen.getByText("Artikel 0")).toBeTruthy();
    fireEvent.change(box, { target: { value: "A-100" } });
    await advance(250);
    expect(screen.getByText("Beratung")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "p1", netPriceCents: 9000, unit: "HUR", taxRate: 19 }));
  });

  it("autoFocus fokussiert das Feld einmalig beim Mount", () => {
    render(<ProductPicker products={LOCAL} taxRates={[19]} onPick={vi.fn()} autoFocus />);
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });
});
