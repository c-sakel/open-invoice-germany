import { describe, it, expect } from "vitest";
import { tableForRefType } from "@/domain/relations";

describe("relations", () => {
  it("ordnet jeden DocRefType einer Tabelle zu", () => {
    expect(tableForRefType("QUOTE")).toBe("quote");
    expect(tableForRefType("INVOICE")).toBe("invoice");
    expect(tableForRefType("RECURRING")).toBe("recurringInvoice");
    expect(tableForRefType("DELIVERY_NOTE")).toBe("deliveryNote");
    expect(tableForRefType("DUNNING")).toBe("dunning");
  });
});
