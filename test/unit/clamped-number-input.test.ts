import { describe, it, expect } from "vitest";
import { parseClampedNumberInput } from "@/lib/forms/clamped-number-input";

describe("parseClampedNumberInput (Fix-Welle 12a, M6)", () => {
  it("geleertes Feld -> min statt 0", () => {
    expect(parseClampedNumberInput("", 15, 40)).toBe(15);
  });
  it("nur Leerraum -> min", () => {
    expect(parseClampedNumberInput("   ", 15, 40)).toBe(15);
  });
  it("nicht-numerischer Rest waehrend des Tippens -> min", () => {
    expect(parseClampedNumberInput("-", 15, 40)).toBe(15);
  });
  it("gueltiger Wert innerhalb der Spanne bleibt unveraendert", () => {
    expect(parseClampedNumberInput("22", 15, 40)).toBe(22);
  });
  it("Wert unterhalb min wird auf min geklemmt", () => {
    expect(parseClampedNumberInput("5", 15, 40)).toBe(15);
  });
  it("Wert oberhalb max wird auf max geklemmt", () => {
    expect(parseClampedNumberInput("999", 15, 40)).toBe(40);
  });
  it("Logobreite-Spanne (10-140 mm)", () => {
    expect(parseClampedNumberInput("", 10, 140)).toBe(10);
    expect(parseClampedNumberInput("200", 10, 140)).toBe(140);
  });
});
