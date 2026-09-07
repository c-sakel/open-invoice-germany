import { describe, it, expect } from "vitest";
import { draftReducer, emptyDraft } from "@/lib/editor/draft";
import { computeDraftTotals } from "@/lib/editor/totals";
describe("editor/totals", () => {
  it("Netto, Rabatt, Steuer je Satz, Brutto, Zwischensumme", () => {
    let s = emptyDraft("INVOICE");
    s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "A", quantity: "2", price: "100", taxRate: 19, discountPercent: "10" } });
    s = draftReducer(s, { type: "addLine", lineType: "ITEM" });
    s = draftReducer(s, { type: "setLine", key: s.lines[1]!.key, patch: { description: "B", quantity: "1", price: "50", taxRate: 7 } });
    s = draftReducer(s, { type: "addLine", lineType: "SUBTOTAL" });
    s = draftReducer(s, { type: "set", field: "documentDiscountPercent", value: "5" });
    const t = computeDraftTotals(s);
    expect(t.lineNetCents).toBe(18000 + 5000);
    expect(t.subtotals[2]).toBe(23000);
    expect(t.allowanceCents).toBe(1150);
    expect(t.netCents).toBe(21850);
    expect(t.taxRows.map((r) => r.rate)).toEqual([19, 7]);
    expect(t.grossCents).toBe(t.netCents + t.taxCents);
    expect(t.error).toBeNull();
  });
  it("Kleinunternehmer: keine Steuer", () => {
    let s = emptyDraft("INVOICE"); s = draftReducer(s, { type: "set", field: "taxScheme", value: "KLEINUNTERNEHMER" });
    s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "A", quantity: "1", price: "100", taxRate: 19 } });
    const t = computeDraftTotals(s); expect(t.taxCents).toBe(0); expect(t.grossCents).toBe(10000);
  });
  it("ungueltige Eingabe liefert error statt zu werfen", () => {
    let s = emptyDraft("INVOICE"); s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "A", quantity: "1", price: "x" } });
    expect(computeDraftTotals(s).error).not.toBeNull();
  });
});
