import { describe, it, expect } from "vitest";
import { parseRateMicros, formatRate, assertSupportedRate, MAX_RATE_MICROS } from "@/domain/fx/decimal";
import { monthlyAverageMicros } from "@/domain/fx/monthly-average";
import { rateDecimalSchema, exchangeRateUpsertSchema, FxRateSource } from "@/schemas/fx";

describe("parseRateMicros", () => {
  it("parst Punkt und Komma ohne Float", () => {
    expect(parseRateMicros("1.1214")).toBe(1121400);
    expect(parseRateMicros("1,1214")).toBe(1121400);
    expect(parseRateMicros("160.72")).toBe(160720000);
    expect(parseRateMicros("0.000001")).toBe(1);
    expect(parseRateMicros("2000")).toBe(MAX_RATE_MICROS);
  });
  it("lehnt Ungueltiges ab", () => {
    expect(() => parseRateMicros("1.1234567")).toThrow(RangeError);
    expect(() => parseRateMicros("0")).toThrow(RangeError);
    expect(() => parseRateMicros("0.000000")).toThrow(RangeError);
    expect(() => parseRateMicros("17000.5")).toThrow(RangeError);
    expect(() => parseRateMicros("abc")).toThrow(RangeError);
    expect(() => parseRateMicros("-1.5")).toThrow(RangeError);
    expect(() => parseRateMicros("")).toThrow(RangeError);
  });
  it("IDR-artiger Kurs (~17000) wird abgelehnt, HUF (~400) akzeptiert", () => {
    expect(() => parseRateMicros("17000")).toThrow(/Int|unterstuetzt|Kurs/);
    expect(parseRateMicros("400.25")).toBe(400250000);
  });
});

describe("assertSupportedRate", () => {
  it("akzeptiert 1..MAX, lehnt Rest mit deutscher Meldung ab", () => {
    expect(() => assertSupportedRate(1)).not.toThrow();
    expect(() => assertSupportedRate(MAX_RATE_MICROS)).not.toThrow();
    expect(() => assertSupportedRate(MAX_RATE_MICROS + 1)).toThrow(RangeError);
    expect(() => assertSupportedRate(17_000_000_000)).toThrow(/2000/);
    expect(() => assertSupportedRate(0)).toThrow(RangeError);
    expect(() => assertSupportedRate(-5)).toThrow(RangeError);
    expect(() => assertSupportedRate(1.5)).toThrow(RangeError);
  });
});

describe("formatRate", () => {
  it("mind. 4, hoechstens 6 Nachkommastellen", () => {
    expect(formatRate(1121400, "de-DE")).toBe("1,1214");
    expect(formatRate(160720000, "en-GB")).toBe("160.7200");
    expect(formatRate(1121412, "de-DE")).toBe("1,121412");
    expect(formatRate(1121410, "en-GB")).toBe("1.12141");
    expect(formatRate(1, "en-GB")).toBe("0.000001");
    expect(formatRate(1_000_000, "de-DE")).toBe("1,0000");
  });
});

describe("monthlyAverageMicros", () => {
  it("mittelt mit halb aufrunden", () => {
    expect(monthlyAverageMicros([1121400, 1121600])).toBe(1121500);
    expect(monthlyAverageMicros([1, 2])).toBe(2);
    expect(monthlyAverageMicros([5])).toBe(5);
    expect(() => monthlyAverageMicros([])).toThrow();
  });
});

describe("fx-Schemas", () => {
  it("rateDecimalSchema", () => {
    expect(rateDecimalSchema.parse("1,1214")).toBe(1121400);
    expect(rateDecimalSchema.safeParse("1.1234567").success).toBe(false);
    expect(rateDecimalSchema.safeParse("17000").success).toBe(false);
    expect(rateDecimalSchema.safeParse("0").success).toBe(false);
  });
  it("Upsert normalisiert Waehrung und Datum", () => {
    const r = exchangeRateUpsertSchema.parse({ source: "ECB", currency: "usd", rateDate: "2108-03-07", rate: "1,08" });
    expect(r.currency).toBe("USD");
    expect(r.rate).toBe(1080000);
    expect(r.rateDate.toISOString()).toBe("2108-03-07T00:00:00.000Z");
    expect(FxRateSource.options).toEqual(["BMF_MONTHLY", "ECB_DAILY"]);
  });
});
