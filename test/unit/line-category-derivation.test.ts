import { describe, it, expect } from "vitest";
import { createInvoiceSchema, updateInvoiceSchema, createDocumentSchema } from "@/schemas";

const line = { description: "Hosting", quantityMilli: 1000, unitNetPriceCents: 1000, taxRate: 0 };
const base = { customerId: "c1" };

describe("Positions-Kategorie aus dem Steuerschema ableiten (REST/Boundaries)", () => {
  it.each([
    ["NICHT_STEUERBAR", "O"],
    ["AUSFUHR", "G"],
    ["IG_LIEFERUNG", "K"],
    ["IG_LEISTUNG", "AE"],
    ["REVERSE_CHARGE", "AE"],
    ["KLEINUNTERNEHMER", "E"],
    ["REGULAR", "S"],
  ] as const)("Schema %s -> Kategorie %s", (taxScheme, cat) => {
    const r = createInvoiceSchema.parse({ ...base, taxScheme, lines: [line] });
    expect(r.lines[0]!.taxCategory).toBe(cat);
  });

  it("explizit gesetzte Kategorie bleibt", () => {
    const r = createInvoiceSchema.parse({ ...base, taxScheme: "AUSFUHR", lines: [{ ...line, taxCategory: "Z" }] });
    expect(r.lines[0]!.taxCategory).toBe("Z");
  });

  it("ohne Schema Default REGULAR -> S", () => {
    expect(createInvoiceSchema.parse({ ...base, lines: [line] }).lines[0]!.taxCategory).toBe("S");
  });

  it("Dokument-Schema leitet ebenfalls ab", () => {
    const r = createDocumentSchema.parse({ kind: "ANGEBOT", ...base, taxScheme: "NICHT_STEUERBAR", lines: [line] });
    expect(r.lines[0]!.taxCategory).toBe("O");
  });

  it("Update: mit Schema im Body abgeleitet, ohne Schema bleibt offen (Domain loest auf)", () => {
    expect(updateInvoiceSchema.parse({ taxScheme: "AUSFUHR", lines: [line] }).lines?.[0]?.taxCategory).toBe("G");
    expect(updateInvoiceSchema.parse({ lines: [line] }).lines?.[0]?.taxCategory).toBeUndefined();
  });
});
