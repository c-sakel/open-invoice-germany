import { describe, it, expect } from "vitest";
import { draftReducer, emptyDraft, draftLinesToPayload, draftLinesFromInitial, toInvoicePayload, type DraftState } from "@/lib/editor/draft";

function build(): DraftState {
  let s = emptyDraft("INVOICE");
  s = draftReducer(s, { type: "set", field: "customerId", value: "c1" });
  s = draftReducer(s, { type: "setLine", key: s.lines[0]!.key, patch: { description: "Beratung", descriptionLong: "Langtext", articleNumber: "A-1", quantity: "2", price: "95,00", unit: "HUR", discountPercent: "10", discountAmount: "5,00" } });
  s = draftReducer(s, { type: "addLine", lineType: "HEADING" });
  s = draftReducer(s, { type: "setLine", key: s.lines[1]!.key, patch: { description: "Abschnitt" } });
  s = draftReducer(s, { type: "addLine", lineType: "TEXT" });
  s = draftReducer(s, { type: "setLine", key: s.lines[2]!.key, patch: { description: "Hinweis" } });
  s = draftReducer(s, { type: "addLine", lineType: "SUBTOTAL" });
  s = draftReducer(s, { type: "setLine", key: s.lines[3]!.key, patch: { description: "Zwischensumme" } });
  return s;
}

describe("editor/draft Zeilenabbildung", () => {
  it("draftLinesToPayload entspricht toInvoicePayload", () => {
    const d = build();
    expect(draftLinesToPayload(d.lines, d.taxScheme)).toEqual(toInvoicePayload(d, false).lines);
  });

  it("KLEINUNTERNEHMER: Steuersatz 0", () => {
    const d = build();
    const lines = draftLinesToPayload(d.lines, "KLEINUNTERNEHMER");
    expect(lines.every((l) => l.taxRate === 0)).toBe(true);
  });

  it("Gliederungszeilen tragen keinen Betrag", () => {
    const d = build();
    for (const l of draftLinesToPayload(d.lines, "REGULAR").slice(1)) {
      expect([l.quantityMilli, l.unitNetPriceCents, l.discountPermille, l.discountCents]).toEqual([0, 0, 0, 0]);
    }
  });

  it("draftLinesFromInitial und zurueck ergibt dieselben Werte", () => {
    const stored = [
      { lineType: "ITEM" as const, description: "Wartung", descriptionLong: "Lang", articleNumber: "W-1", quantity: "1,5", unit: "HUR", price: "100,00", taxRate: 19, discountPercent: "", discountAmount: "5,00" },
      { lineType: "HEADING" as const, description: "Teil", descriptionLong: "", articleNumber: "", quantity: "0", unit: "C62", price: "0,00", taxRate: 19, discountPercent: "", discountAmount: "" },
    ];
    const draft = draftLinesFromInitial(stored, [19, 7, 0]);
    expect(draft[0]).toMatchObject({ lineType: "ITEM", descriptionLong: "Lang", articleNumber: "W-1", discountAmount: "5,00" });
    const payload = draftLinesToPayload(draft, "REGULAR");
    expect(payload[0]).toMatchObject({ quantityMilli: 1500, unitNetPriceCents: 10000, discountCents: 500, taxRate: 19, descriptionLong: "Lang" });
    const again = draftLinesToPayload(draftLinesFromInitial(stored, [19, 7, 0]), "REGULAR");
    expect(again).toEqual(payload);
    expect(payload[1]!.lineType).toBe("HEADING");
  });

  it("ohne gespeicherte Zeilen eine leere Position", () => {
    expect(draftLinesFromInitial(undefined, [19])).toHaveLength(1);
  });
});
