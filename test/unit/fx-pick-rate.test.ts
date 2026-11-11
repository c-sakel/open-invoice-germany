import { describe, it, expect } from "vitest";
import { pickRate, fxStichtag, type FxRow } from "@/domain/fx/pick-rate";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ecb = (date: string, m: number, currency = "USD"): FxRow => ({ source: "ECB", currency, rateDate: d(date), rateMicros: m });
const mon = (date: string, m: number, currency = "USD"): FxRow => ({ source: "MONTHLY", currency, rateDate: d(date), rateMicros: m });

describe("pickRate ECB_DAILY", () => {
  it("Samstag -> Freitagskurs", () => {
    const p = pickRate([ecb("2108-03-06", 1), ecb("2108-03-07", 2)], "USD", d("2108-03-08"), "ECB_DAILY");
    expect(p).toEqual({ rateMicros: 2, rateDate: d("2108-03-07"), source: "ECB_DAILY" });
  });
  it("8 Tage alt -> null, 7 Tage alt -> Kurs", () => {
    expect(pickRate([ecb("2108-03-01", 5)], "USD", d("2108-03-09"), "ECB_DAILY")).toBeNull();
    expect(pickRate([ecb("2108-03-02", 5)], "USD", d("2108-03-09"), "ECB_DAILY")?.rateMicros).toBe(5);
  });
  it("Kurs nach dem Stichtag nie", () => {
    expect(pickRate([ecb("2108-03-09", 9)], "USD", d("2108-03-08"), "ECB_DAILY")).toBeNull();
  });
  it("Stichtag mit Uhrzeit zaehlt als Tag", () => {
    const p = pickRate([ecb("2108-03-08", 3)], "USD", new Date("2108-03-08T15:30:00.000Z"), "ECB_DAILY");
    expect(p?.rateMicros).toBe(3);
  });
  it("ignoriert MONTHLY-Zeilen und fremde Waehrung", () => {
    expect(pickRate([mon("2108-03-01", 7), ecb("2108-03-07", 8, "GBP")], "USD", d("2108-03-08"), "ECB_DAILY")).toBeNull();
  });
});

describe("pickRate BMF_MONTHLY", () => {
  it("Stichtagsmonat bevorzugt", () => {
    const p = pickRate([mon("2108-02-01", 1), mon("2108-03-01", 2)], "USD", d("2108-03-15"), "BMF_MONTHLY");
    expect(p).toEqual({ rateMicros: 2, rateDate: d("2108-03-01"), source: "BMF_MONTHLY" });
  });
  it("Konvention: Monatszeile am 1. wird vom Stichtag 15. (und 1.) gefunden", () => {
    expect(pickRate([mon("2108-03-01", 2)], "USD", d("2108-03-15"), "BMF_MONTHLY")?.rateDate).toEqual(d("2108-03-01"));
    expect(pickRate([mon("2108-03-01", 2)], "USD", d("2108-03-01"), "BMF_MONTHLY")?.rateMicros).toBe(2);
  });
  it("Vormonat-Fallback, Vor-Vormonat null", () => {
    expect(pickRate([mon("2108-02-01", 1)], "USD", d("2108-03-15"), "BMF_MONTHLY")?.rateMicros).toBe(1);
    expect(pickRate([mon("2108-01-01", 1)], "USD", d("2108-03-15"), "BMF_MONTHLY")).toBeNull();
  });
  it("Jahreswechsel: Januar -> Dezember Vorjahr", () => {
    expect(pickRate([mon("2107-12-01", 4)], "USD", d("2108-01-10"), "BMF_MONTHLY")?.rateMicros).toBe(4);
  });
  it("ignoriert ECB-Zeilen und fremde Waehrung", () => {
    expect(pickRate([ecb("2108-03-01", 1), mon("2108-03-01", 2, "GBP")], "USD", d("2108-03-15"), "BMF_MONTHLY")).toBeNull();
  });
});

describe("fxStichtag", () => {
  it("deliveryDate vor deliveryEnd vor issueDate", () => {
    const issueDate = d("2108-03-10");
    expect(fxStichtag({ deliveryDate: d("2108-03-01"), deliveryEnd: d("2108-03-05"), issueDate })).toEqual(d("2108-03-01"));
    expect(fxStichtag({ deliveryDate: null, deliveryEnd: d("2108-03-05"), issueDate })).toEqual(d("2108-03-05"));
    expect(fxStichtag({ deliveryDate: null, deliveryEnd: null, issueDate })).toEqual(issueDate);
  });
});
