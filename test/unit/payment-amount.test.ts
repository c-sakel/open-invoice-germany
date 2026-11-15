import { describe, expect, it } from "vitest";
import { centsToDecimal, decimalToCents } from "@/lib/payment/amount";

describe("Zahlungsbetraege", () => {
  it.each([0, 1, 99, 100, 123456])("%i Cent hin und zurueck", (c) => {
    expect(decimalToCents(centsToDecimal(c))).toBe(c);
  });
  it("formatiert mit zwei Nachkommastellen", () => {
    expect(centsToDecimal(1234)).toBe("12.34");
    expect(centsToDecimal(5)).toBe("0.05");
  });
  it.each(["12.3", "12.345", "-1.00", "1e3", " 1.00", "1,00", ""])("lehnt %j ab", (v) => {
    expect(() => decimalToCents(v)).toThrow();
  });
  it("lehnt negative und gebrochene Cent ab", () => {
    expect(() => centsToDecimal(-1)).toThrow();
    expect(() => centsToDecimal(1.5)).toThrow();
  });
});
