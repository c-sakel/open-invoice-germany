import { describe, it, expect } from "vitest";
import { currencyOptions, currencySymbol, EDITOR_CURRENCIES } from "@/lib/currencies";

describe("currencies", () => {
  it("haengt einen unbekannten Bestandswert an", () => {
    const o = currencyOptions("JPY");
    for (const c of EDITOR_CURRENCIES) expect(o).toContain(c);
    expect(o).toContain("JPY");
  });
  it("erzeugt keine Duplikate fuer bekannte Werte", () => {
    expect(currencyOptions("EUR").filter((c) => c === "EUR")).toHaveLength(1);
    expect(currencyOptions("")).toHaveLength(EDITOR_CURRENCIES.length);
  });
  it("currencySymbol", () => {
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("CHF")).toBe("CHF");
  });
});
