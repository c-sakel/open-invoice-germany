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

  it("lehnt mehr Nachkommastellen als erlaubt ab statt still zu runden", () => {
    // "1.234" bei Geld ist mehrdeutig (1234 EUR oder 1,234 EUR) -> Fehler statt 123 Cent
    expect(parseDecimalInput("1.234", 2)).toBeNull();
    expect(parseDecimalInput("1,234", 2)).toBeNull();
    expect(parseDecimalInput("1,2345", 3)).toBeNull();
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
