import { describe, it, expect } from "vitest";
import { draftReducer, emptyDraft, draftLinesFromInitial, draftLinesToPayload, validateDraft, type DraftState } from "@/lib/editor/draft";
import { computeDraftTotals } from "@/lib/editor/totals";
import { priceFieldError, PRICE_FIELD_ERROR } from "@/lib/editor/parse";

function withLine(price: string, quantity: string): DraftState {
  let s = emptyDraft("INVOICE");
  s = draftReducer(s, { type: "set", field: "customerId", value: "c1" });
  return draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "API-Aufrufe", quantity, price, taxRate: 19 } });
}

describe("Editor: Einzelpreis mit bis zu 5 Nachkommastellen (18f)", () => {
  it("0,002 x 10000 ergibt Netto 2000 und Payload mit Milli-Preis", () => {
    const d = withLine("0,002", "10000");
    expect(computeDraftTotals(d).netCents).toBe(2000);
    const [line] = draftLinesToPayload(d.lines, d.taxScheme);
    expect(line!.unitNetPriceCents).toBe(0);
    expect(line!.unitNetPriceMilliCents).toBe(200);
  });

  it("12,50 ergibt Milli null", () => {
    const [line] = draftLinesToPayload(withLine("12,50", "1").lines, "REGULAR");
    expect(line!.unitNetPriceCents).toBe(1250);
    expect(line!.unitNetPriceMilliCents).toBeNull();
  });

  it("1.234 ist mehrdeutig: Feldfehler und Validierungsproblem", () => {
    expect(priceFieldError("1.234")).toBe("Preis mehrdeutig oder mehr als 5 Nachkommastellen");
    expect(PRICE_FIELD_ERROR).toBe("Preis mehrdeutig oder mehr als 5 Nachkommastellen");
    expect(priceFieldError("")).toBeNull();
    expect(priceFieldError("0,123456")).not.toBeNull();
    const problems = validateDraft(withLine("1.234", "1"));
    expect(problems.some((p) => p.includes("Preis mehrdeutig oder mehr als 5 Nachkommastellen"))).toBe(true);
  });

  it("Initialzustand: {0, 200} -> 0,002; {1250, null} -> 12,50", () => {
    const mk = (price: string) => ({ lineType: "ITEM" as const, description: "x", descriptionLong: "", articleNumber: "", quantity: "1", unit: "C62", price, taxRate: 19, discountPercent: "0", discountAmount: "0,00" });
    // Seiten reichen fromPrice() ({cents, milli}) als Feldtext durch; Round-Trip bleibt stabil.
    expect(draftLinesFromInitial([mk("0,002")], [19])[0]!.price).toBe("0,002");
    expect(draftLinesFromInitial([mk("12.50")], [19])[0]!.price).toBe("12,50");
  });
});
