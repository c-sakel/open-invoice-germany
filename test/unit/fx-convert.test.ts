import { describe, it, expect } from "vitest";
import { MAX_RATE_MICROS } from "@/domain/fx/decimal";
import { toEurCents } from "@/domain/fx/convert";

describe("toEurCents", () => {
  it("rechnet Fremdwaehrung in EUR-Cent um", () => {
    expect(toEurCents(11214, 1121400)).toBe(10000);
    expect(toEurCents(0, 1121400)).toBe(0);
  });
  it("halbes Runden weg von null, symmetrisch", () => {
    expect(toEurCents(1, 2000000)).toBe(1);
    expect(toEurCents(-1, 2000000)).toBe(-1);
    expect(toEurCents(-5, 1121400)).toBe(-toEurCents(5, 1121400));
    expect(toEurCents(1, 3000000)).toBe(0);
  });
  it("grosse Betraege ohne Float-Fehler", () => {
    expect(toEurCents(99_999_999_999, 1121400)).toBe(89_174_246_477);
  });
  it("Grenzkurs MAX_RATE_MICROS", () => {
    expect(toEurCents(1, MAX_RATE_MICROS)).toBe(0);
    expect(toEurCents(1000, MAX_RATE_MICROS)).toBe(1);
  });
  it("Ueberlauf des sicheren Zahlenbereichs wirft", () => {
    expect(() => toEurCents(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });
  it("lehnt nicht unterstuetzte Kurse und Nicht-Integer ab", () => {
    expect(() => toEurCents(100, 0)).toThrow(RangeError);
    expect(() => toEurCents(100, 17_000_000_000)).toThrow(RangeError);
    expect(() => toEurCents(1.5, 1121400)).toThrow(RangeError);
  });
});
