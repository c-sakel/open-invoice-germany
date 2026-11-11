import { describe, it, expect } from "vitest";
import { parseDecimalInput } from "@/lib/money";

describe("parseDecimalInput (Formulareingaben Geld/Menge/Prozent)", () => {
  it("liest deutsches Format mit Tausenderpunkt als Cent", () => {
    expect(parseDecimalInput("1.234,56", 2)).toBe(123456);
    expect(parseDecimalInput("1.234.567,8", 2)).toBe(123456780);
  });

  it("liest Punkt als Dezimaltrenner (Vorbelegung toFixed)", () => {
    expect(parseDecimalInput("1234.56", 2)).toBe(123456);
    expect(parseDecimalInput("12,5", 2)).toBe(1250);
    expect(parseDecimalInput(" 1 234,56 € ", 2)).toBe(123456);
  });

  it("liest mehrere Punkte ohne Komma als Tausendertrenner", () => {
    expect(parseDecimalInput("1.234.567", 2)).toBe(123456700);
  });

  it("lehnt '1.234' ohne Komma bei weniger als 3 Nachkommastellen als mehrdeutig ab", () => {
    // 1234 EUR oder 1,234 EUR? -> Fehler statt still 123 Cent
    expect(parseDecimalInput("1.234", 2)).toBeNull();
    expect(parseDecimalInput("12.500", 1)).toBeNull();
  });

  it("rundet eindeutige Eingaben mit mehr Nachkommastellen kaufmaennisch", () => {
    expect(parseDecimalInput("1,234", 2)).toBe(123);
    expect(parseDecimalInput("0,125", 2)).toBe(13);
    expect(parseDecimalInput("2,55", 1)).toBe(26);
    expect(parseDecimalInput("33,33", 1)).toBe(333);
    expect(parseDecimalInput("1,2345", 3)).toBe(1235);
    expect(parseDecimalInput("12.3456", 2)).toBe(1235);
  });

  it("Mengen mit drei Nachkommastellen", () => {
    expect(parseDecimalInput("1.234", 3)).toBe(1234);
    expect(parseDecimalInput("2,5", 3)).toBe(2500);
  });

  it("Prozent mit einer Nachkommastelle (Promille)", () => {
    expect(parseDecimalInput("12,5 %", 1)).toBe(125);
  });

  it("leere und unsinnige Eingaben ergeben null", () => {
    expect(parseDecimalInput("", 2)).toBeNull();
    expect(parseDecimalInput("abc", 2)).toBeNull();
    expect(parseDecimalInput("1,2,3", 2)).toBeNull();
    expect(parseDecimalInput("1,234.56", 2)).toBeNull();
  });

  it("negative Werte bleiben negativ", () => {
    expect(parseDecimalInput("-1.234,50", 2)).toBe(-123450);
  });
});
