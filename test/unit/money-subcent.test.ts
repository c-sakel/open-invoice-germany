import { describe, expect, it } from "vitest";
import {
  formatUnitPrice,
  milliCentsToCents,
  milliCentsToDecimal,
  mulDivRoundHalfUp,
  normalizeMilli,
  parseUnitPriceInput,
  unitPriceToInput,
} from "../../src/lib/money";

describe("mulDivRoundHalfUp", () => {
  it("rechnet 10.000 x 0,002 EUR = 20,00 EUR", () => {
    expect(mulDivRoundHalfUp(10_000_000, 200, 1_000_000)).toBe(2000);
  });
  it("rundet Half-Up symmetrisch", () => {
    expect(mulDivRoundHalfUp(500_000, 1, 1e6)).toBe(1);
    expect(mulDivRoundHalfUp(-500_000, 1, 1e6)).toBe(-1);
    expect(mulDivRoundHalfUp(499_999, 1, 1e6)).toBe(0);
  });
  it("ist im BigInt-Pfad exakt", () => {
    expect(mulDivRoundHalfUp(1e9, 2_147_483_647, 1e6)).toBe(2147483647000);
  });
  it("wirft bei Ergebnis ausserhalb des sicheren Bereichs", () => {
    expect(() => mulDivRoundHalfUp(Number.MAX_SAFE_INTEGER, 4, 1)).toThrow(RangeError);
  });
});

describe("milliCentsToCents / normalizeMilli / milliCentsToDecimal", () => {
  it("rundet Milli-Cent auf Cent", () => {
    expect(milliCentsToCents(200)).toBe(0);
    expect(milliCentsToCents(500)).toBe(1);
    expect(milliCentsToCents(1500)).toBe(2);
    expect(milliCentsToCents(-1500)).toBe(-2);
    expect(milliCentsToCents(2147483647)).toBe(2147484);
  });
  it("normalisiert ganze Cent zu null", () => {
    expect(normalizeMilli(839000)).toBeNull();
    expect(normalizeMilli(839500)).toBe(839500);
    expect(normalizeMilli(null)).toBeNull();
    expect(normalizeMilli(undefined)).toBeNull();
  });
  it("liefert 5 Nachkommastellen", () => {
    expect(milliCentsToDecimal(200)).toBe("0.00200");
    expect(milliCentsToDecimal(839500)).toBe("8.39500");
    expect(milliCentsToDecimal(-839500)).toBe("-8.39500");
    expect(milliCentsToDecimal(1)).toBe("0.00001");
    expect(milliCentsToDecimal(2147483647)).toBe("21474.83647");
  });
});

describe("formatUnitPrice / unitPriceToInput", () => {
  const nb = (s: string) => s.replace(/\s/g, " ");
  it("formatiert 2..5 Stellen", () => {
    expect(nb(formatUnitPrice({ unitNetPriceCents: 1250 }))).toBe("12,50 €");
    expect(nb(formatUnitPrice({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 }))).toBe("0,002 €");
    expect(nb(formatUnitPrice({ unitNetPriceCents: 123457, unitNetPriceMilliCents: 123456780 }))).toBe("1.234,5678 €");
    expect(nb(formatUnitPrice({ unitNetPriceCents: 840, unitNetPriceMilliCents: 839500 }))).toBe("8,395 €");
    expect(formatUnitPrice({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 }, "EUR", "en-GB")).toBe("€0.002");
  });
  it("belegt das Editorfeld vor", () => {
    expect(unitPriceToInput({ unitNetPriceCents: 0, unitNetPriceMilliCents: 200 })).toBe("0,002");
    expect(unitPriceToInput({ unitNetPriceCents: 1250 })).toBe("12,50");
    expect(unitPriceToInput({ unitNetPriceCents: 1250 }, "en-GB")).toBe("12.50");
  });
});

describe("parseUnitPriceInput", () => {
  it.each([
    ["0,002", { cents: 0, milliCents: 200 }],
    ["0.002", { cents: 0, milliCents: 200 }],
    ["1,234", { cents: 123, milliCents: 123400 }],
    ["12,50", { cents: 1250, milliCents: null }],
    ["12.5", { cents: 1250, milliCents: null }],
    ["1.234,5678", { cents: 123457, milliCents: 123456780 }],
    ["21.474,83647", { cents: 2147484, milliCents: 2147483647 }],
    ["50.000,00", { cents: 5000000, milliCents: null }],
  ])("parst %s", (input, expected) => {
    expect(parseUnitPriceInput(input)).toEqual(expected);
  });
  it.each(["1.234", "0,000001", "-1", "21.474,83648", "", "abc", "1,"])("lehnt %j ab", (input) => {
    expect(parseUnitPriceInput(input)).toBeNull();
  });
});
