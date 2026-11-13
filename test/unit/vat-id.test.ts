import { describe, expect, it } from "vitest";
import { normalizeVatId, splitVatId, vatIdFormatProblem } from "@/lib/vat-id";

describe("vat-id", () => {
  it("normalisiert Schreibweisen", () => {
    expect(normalizeVatId(" de 123.456-789 ")).toBe("DE123456789");
    expect(normalizeVatId("GR123456789")).toBe("EL123456789");
  });
  it("erkennt Formatprobleme", () => {
    expect(vatIdFormatProblem("CH123456789")).not.toBeNull();
    expect(vatIdFormatProblem("US123456789")).not.toBeNull();
    expect(vatIdFormatProblem("DE12345678")).not.toBeNull();
    expect(vatIdFormatProblem("DE123456789")).toBeNull();
    expect(vatIdFormatProblem("ATU12345678")).toBeNull();
    expect(vatIdFormatProblem("XI123456789")).toBeNull();
    expect(vatIdFormatProblem("FRXX123456789")).toBeNull();
  });
  it("teilt Praefix und Nummer", () => {
    expect(splitVatId("EL123456789")).toEqual({ countryCode: "EL", number: "123456789" });
    expect(splitVatId("gr 123456789")).toEqual({ countryCode: "EL", number: "123456789" });
  });
});
